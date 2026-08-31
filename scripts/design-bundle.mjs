/**
 * Build the Claude Design bundle from the app's own stylesheet.
 *
 * Each preview in `design/src` declares which stylesheet sections it needs. This script
 * pulls those sections out of `web/styles.css` and inlines them, so a preview is a single
 * self-contained file and `web/styles.css` stays the one source of truth.
 *
 * Sections are split on the top-level comment headers already in the stylesheet, which is
 * why previews carry one component's rules rather than the whole file: an edit made in
 * Claude Design then maps back to exactly one section here.
 */
import { createReadStream, promises as fs } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = path.join(root, 'design', 'src')
const outDir = path.join(root, 'design', 'dist')

/**
 * Split the stylesheet into `{ name -> css }`, keyed by its comment headers.
 *
 * The stylesheet writes a section header as a one-line comment followed by a blank line,
 * and a comment explaining the rules right below it as a one-line comment with no gap.
 * That gap is the whole difference, so it is what the split reads: without it, prose like
 * "Drag handle straddling the rail's left edge." opened a section of its own and the rail
 * previews shipped without the CSS for their own tabs.
 */
function splitSections(css) {
  const lines = css.split('\n')
  const sections = new Map()
  let name = 'Tokens'
  let buffer = []
  for (const [at, line] of lines.entries()) {
    const header = line.match(/^\/\* (.+) \*\/$/)
    if (header && (lines[at + 1] ?? '').trim() === '') {
      sections.set(name, (sections.get(name) ?? '') + buffer.join('\n').trim() + '\n')
      name = header[1]
      buffer = []
      continue
    }
    buffer.push(line)
  }
  sections.set(name, (sections.get(name) ?? '') + buffer.join('\n').trim() + '\n')
  return sections
}

/** Sections whose rules belong to a neighbour rather than standing on their own. */
const MERGE_INTO = {
  "The agent's recent tool calls, oldest first.": 'Subagents rail',
  'Images inside a sent message': 'Image attachments',
}

const PREVIEW_CHROME = `
/* Preview frame — not part of the app. */
html { background: var(--bg); }
body { padding: 24px; }
.ds-note {
  margin: 0 0 14px;
  font-family: var(--mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--text-faint);
}
.ds-sub {
  margin: 0 0 18px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-dim);
  max-width: 88ch;
  text-wrap: pretty;
}
.ds-row { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
.ds-col { flex: none; display: flex; flex-direction: column; gap: 8px; }
.ds-cap { font-family: var(--mono); font-size: 10px; color: var(--text-faint); }
.ds-cap b { color: var(--text); font-weight: 600; }
.ds-frame .rail { width: 100%; min-width: 0; border-left: 0; }
.ds-stack { display: flex; flex-direction: column; gap: 14px; }
.ds-frame {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg);
}
`

/**
 * Which sections define each class name.
 *
 * A name can have rules in more than one section — `.act` is a fleet button and, scoped
 * under `.rail`, a file action — so this is a set rather than a single owner.
 */
function definersOfClass(sections) {
  const definers = new Map()
  for (const [name, body] of sections) {
    for (const match of body.matchAll(/\.([A-Za-z][\w-]*)/g)) {
      const found = definers.get(match[1])
      if (found) found.add(name)
      else definers.set(match[1], new Set([name]))
    }
  }
  return definers
}

/**
 * Sections a preview needs but did not ask for.
 *
 * A preview is the app's own stylesheet applied to a fragment of the app's own markup, so
 * a class the bundle leaves unstyled is a preview that lies about how the app looks — which
 * is how the rail previews came to ship without the CSS for their own tabs. A class no
 * section defines is not reported: `diff--git` and `dline--ctx` are hooks the app sets and
 * styles nothing by, and preview scaffolding is legitimately its own thing.
 */
function missingSections(markup, wanted, definers) {
  const asked = new Set(['Tokens', ...wanted])
  const missing = new Set()
  for (const match of markup.matchAll(/class="([^"]+)"/g)) {
    for (const name of match[1].split(/\s+/)) {
      if (!name || name.startsWith('ds-')) continue
      const found = definers.get(name)
      if (!found || [...found].some((section) => asked.has(section))) continue
      for (const section of found) missing.add(section)
    }
  }
  return [...missing].sort()
}

async function main() {
  const css = await fs.readFile(path.join(root, 'web', 'styles.css'), 'utf8')
  const raw = splitSections(css)

  const sections = new Map()
  for (const [name, body] of raw) {
    const target = MERGE_INTO[name] ?? name
    sections.set(target, (sections.get(target) ?? '') + body)
  }

  const definers = definersOfClass(sections)

  await fs.rm(outDir, { recursive: true, force: true })
  const templates = (await fs.readdir(srcDir)).filter((f) => f.endsWith('.html'))
  const built = []

  for (const file of templates) {
    const template = await fs.readFile(path.join(srcDir, file), 'utf8')
    const request = template.match(/<!--\s*@styles:\s*(.+?)\s*-->/)
    if (!request) throw new Error(`${file} has no "@styles:" line`)

    const wanted = request[1].split(',').map((s) => s.trim())
    const missing = wanted.filter((name) => !sections.has(name))
    if (missing.length > 0) throw new Error(`${file} wants unknown sections: ${missing.join(', ')}`)

    const bundle = ['Tokens', ...wanted.filter((n) => n !== 'Tokens')]
      .map((name) => `/* ===== ${name} ===== */\n${sections.get(name).trim()}`)
      .join('\n\n')

    const withStyles = template.replace(
      request[0],
      `<style>\n${bundle}\n\n${PREVIEW_CHROME.trim()}\n</style>`,
    )

    // The @dsCard marker has to stay on line one, and the charset declaration has to come
    // before any text, or middot and >= characters are decoded as Latin-1.
    const lines = withStyles.split('\n')
    const html = [lines[0], '<meta charset="utf-8" />', ...lines.slice(1)].join('\n')

    const outPath = path.join(outDir, file)
    await fs.mkdir(path.dirname(outPath), { recursive: true })
    await fs.writeFile(outPath, html)
    built.push({ file, sections: wanted, bytes: html.length, missing: missingSections(template, wanted, definers) })
  }

  for (const entry of built) {
    console.log(`  ${entry.file.padEnd(24)} ${String(entry.bytes).padStart(6)} B  ← ${entry.sections.join(', ')}`)
  }
  console.log(`\nbuilt ${built.length} previews into design/dist`)

  const short = built.filter((entry) => entry.missing.length > 0)
  for (const entry of short) {
    console.warn(`\n! ${entry.file} renders unstyled without: ${entry.missing.join(', ')}`)
  }
  if (short.length > 0) console.warn('\n  Add those to the preview\'s "@styles:" line.')
}

/**
 * Serve `design/dist` on 127.0.0.1 so the previews can be opened in a browser.
 *
 * This exists so the design round trip needs nothing but Node. It was a `python3 -m
 * http.server` one-liner, which meant `npm run design:preview` failed on a machine with
 * no Python for a project that otherwise has no Python in it.
 */
function serve(port) {
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' }
  const server = http.createServer(async (req, res) => {
    const requested = decodeURIComponent((req.url ?? '/').split('?')[0])
    const resolved = path.resolve(outDir, '.' + (requested === '/' ? '/index.html' : requested))
    // Refuse anything that resolves outside the preview directory.
    const inside = resolved === outDir || resolved.startsWith(outDir + path.sep)
    if (!inside) {
      res.writeHead(403).end('forbidden')
      return
    }
    try {
      const stat = await fs.stat(resolved)
      if (stat.isDirectory()) throw new Error('directory')
      res.writeHead(200, { 'content-type': types[path.extname(resolved)] ?? 'application/octet-stream' })
      createReadStream(resolved).pipe(res)
    } catch {
      // No index page is generated, so list the previews instead of 404ing the bare root.
      const files = (await fs.readdir(outDir)).filter((name) => name.endsWith('.html')).sort()
      res.writeHead(requested === '/index.html' ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><meta charset="utf-8"><title>aivis design previews</title>` +
        `<style>body{font:14px system-ui;margin:40px;line-height:1.8}a{display:block}</style>` +
        `<h1>aivis design previews</h1>` + files.map((name) => `<a href="/${name}">${name}</a>`).join(''))
    }
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`\nserving design/dist on http://127.0.0.1:${port}`)
  })
}

await main()

if (process.argv.includes('--serve')) {
  const at = process.argv.indexOf('--port')
  serve(at === -1 ? 4321 : Number(process.argv[at + 1]))
}
