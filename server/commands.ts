import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type { CommandHit, CommandSearch } from '../shared/types.ts'

const run = promisify(execFile)

/**
 * Slash commands and skills, discovered and expanded the way the Claude Code CLI does.
 *
 * Two kinds of `/` token exist, and they need opposite handling:
 *
 *   - **Prompt commands** (`.md` under a `commands/` directory) and **skills** (`SKILL.md`
 *     under a `skills/` directory) reduce to *text*. The CLI expands them client-side into a
 *     prompt before anything is sent. aivis does the same in `expandCommand`, so a `/graphify`
 *     typed in the browser fires the skill in the live session exactly as it would in a
 *     terminal — this is the same style of client-side expansion aivis already does for `@`.
 *
 *   - **Built-in commands** (`/compact`, `/clear`, `/model`, …) are actions of the terminal
 *     client, not messages to the model. They never travel as a turn, so aivis cannot run
 *     them. They are listed only for discoverability, marked `runnable: false`.
 */

interface Entry extends CommandHit {
  /** Absolute path to the `.md` file (a `SKILL.md` for skills); empty for built-ins. */
  file: string
}

const CACHE_MS = 15000
const cache = new Map<string, { at: number; entries: Entry[] }>()

/**
 * Built-in terminal commands. These are actions of the terminal client, not messages, so
 * aivis cannot run them; they are listed only for discoverability, marked `runnable: false`.
 *
 * The authoritative list lives inside the installed Claude Code binary and changes with
 * every release, so a hardcoded list here would always drift. Instead `discoverBuiltins`
 * reads the real command registry out of the installed bundle and caches it, and this
 * fallback is used only when the bundle cannot be located or read.
 */
const FALLBACK_BUILTINS: { name: string; description: string }[] = [
  { name: 'add-dir', description: 'Add a new working directory' },
  { name: 'agents', description: 'Manage subagents' },
  { name: 'clear', description: 'Start a new session with empty context' },
  { name: 'compact', description: 'Free up context by summarizing the conversation so far' },
  { name: 'config', description: 'Open settings' },
  { name: 'context', description: 'Visualize current context usage as a colored grid' },
  { name: 'cost', description: 'Show token cost for this session' },
  { name: 'doctor', description: 'Diagnose the installation' },
  { name: 'effort', description: 'Set effort level for model usage' },
  { name: 'exit', description: 'Exit the session' },
  { name: 'export', description: 'Export the current conversation to a file or clipboard' },
  { name: 'fast', description: 'Toggle fast mode' },
  { name: 'feedback', description: 'Send feedback to Anthropic or report a bug' },
  { name: 'help', description: 'Show help and available commands' },
  { name: 'hooks', description: 'View hook configurations for tool events' },
  { name: 'ide', description: 'Manage IDE integrations and show status' },
  { name: 'init', description: 'Generate a CLAUDE.md for this project' },
  { name: 'login', description: 'Sign in to your account' },
  { name: 'logout', description: 'Sign out from your Anthropic account' },
  { name: 'mcp', description: 'Manage MCP servers' },
  { name: 'memory', description: 'Edit CLAUDE.md files and memory settings' },
  { name: 'model', description: 'Set the model for this session' },
  { name: 'permissions', description: 'Review and edit tool permissions' },
  { name: 'plan', description: 'Enable plan mode or view the current session plan' },
  { name: 'release-notes', description: 'Show release notes' },
  { name: 'resume', description: 'Resume a previous conversation' },
  { name: 'rewind', description: 'Rewind to an earlier checkpoint' },
  { name: 'status', description: 'Show Claude Code status' },
  { name: 'terminal-setup', description: 'Configure terminal key bindings' },
  { name: 'usage', description: 'Show usage and rate-limit status' },
]

/** Descriptions for the common built-ins, shown as the pill's tooltip when discovered. */
const DESC_HINTS = new Map(FALLBACK_BUILTINS.map((entry) => [entry.name, entry.description]))

/** Pseudo-commands the registry carries that are internal states, not things a user types. */
const BUILTIN_DENY = new Set(['workflow-launch-exec', 'pro-trial-expired', 'rate-limit-options'])

const BUILTINS_TTL = 10 * 60 * 1000
let builtinsCache: { at: number; list: CommandHit[] } | null = null

/** The installed Claude Code executable, whose bundle holds the command registry. */
async function claudeBundlePath(): Promise<string | null> {
  const home = os.homedir()
  const candidates: string[] = [
    path.join(home, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]
  try {
    const { stdout } = await run('which', ['claude'], { timeout: 3000 })
    if (stdout.trim()) candidates.unshift(stdout.trim())
  } catch {
    // `which` missing or claude not on PATH — the fixed candidates still cover common installs.
  }
  for (const candidate of candidates) {
    try {
      const real = await fs.realpath(candidate)
      const stat = await fs.stat(real)
      // The real target is the bundle (a large Mach-O for the native build, a multi-MB
      // cli.js for the npm build); a small shim is not it.
      if (stat.isFile() && stat.size > 1_000_000) return real
    } catch {
      // Missing candidate — try the next.
    }
  }
  return null
}

/**
 * Every match of an ERE pattern in the bundle, in one pass. Prefers ripgrep, which scans
 * the 180MB+ bundle in a fraction of grep's time, and falls back to grep where rg is not
 * installed. `LC_ALL=C` and the binary-as-text flag keep it scanning bytes as bytes.
 */
async function scanBundle(bundle: string, pattern: string): Promise<string[]> {
  // On macOS `/usr/bin/grep` is BSD grep, which is ~100× slower than an automaton-based
  // matcher on this near-single-line binary (~2s vs ~0.02s). So prefer ripgrep, then GNU
  // grep (`ggrep` on a Homebrew mac), and fall back to plain `grep` last — which is GNU grep
  // and fast on Linux, and the slow BSD one only on a mac without the faster tools.
  const attempts: [string, string[]][] = [
    ['rg', ['-aoN', '--no-config', '-e', pattern, bundle]],
    ['ggrep', ['-aoE', pattern, bundle]],
    ['grep', ['-aoE', pattern, bundle]],
  ]
  for (const [cmd, args] of attempts) {
    try {
      const { stdout } = await run(cmd, args, {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 20000,
        env: { ...process.env, LC_ALL: 'C' },
      })
      return stdout.split('\n').filter(Boolean)
    } catch (err) {
      // Tool not installed → try the next one. Any other failure (exit 1 = no matches, or an
      // unreadable file) → nothing to return.
      if ((err as { code?: string }).code === 'ENOENT') continue
      return []
    }
  }
  return []
}

/**
 * Command names read straight out of the installed bundle.
 *
 * Only names are scanned for, and only through the one pattern that stays fast: the command
 * object's `type:"local"` / `"local-jsx"` marker with the name right after it. That literal
 * anchor is rare, so the scan reads the 180MB+ single-line binary in a few hundredths of a
 * second. Every other shape backtracks catastrophically in BSD grep — a pattern starting at
 * the ubiquitous `name:"`, or any `.{0,N}` window — so they are avoided. The handful of
 * commands defined name-before-type are recovered from the curated fallback in the union
 * below, not by a slower scan; descriptions likewise come from `DESC_HINTS`, since a
 * `description:"…"` scan is both slow and matches thousands of non-command objects.
 */
async function extractBuiltinNames(bundle: string): Promise<string[]> {
  const lines = await scanBundle(bundle, 'type:"local(-jsx)?",name:"[a-z][a-z0-9_-]{1,30}"')
  const names = new Set<string>()
  for (const line of lines) {
    const match = line.match(/name:"([a-z][a-z0-9_-]{1,30})"/)
    if (match && !BUILTIN_DENY.has(match[1] as string)) names.add(match[1] as string)
  }
  return [...names]
}

let builtinsInflight: Promise<CommandHit[]> | null = null

/** Scan the bundle and rebuild the built-in list, deduping concurrent runs. */
function refreshBuiltins(): Promise<CommandHit[]> {
  if (!builtinsInflight) {
    builtinsInflight = (async () => {
      // Always include the curated names, then add the version-accurate extras the bundle
      // scan finds. The union means the scan can only ever add commands, never drop an
      // important one it happens to miss (or miss everything, when the bundle is unreadable).
      const names = new Set(FALLBACK_BUILTINS.map((entry) => entry.name))
      const bundle = await claudeBundlePath()
      if (bundle) {
        for (const name of await extractBuiltinNames(bundle)) names.add(name)
      }
      const list: CommandHit[] = [...names].sort().map((name) => ({
        name,
        description: DESC_HINTS.get(name) ?? '',
        kind: 'builtin',
        source: 'terminal',
        runnable: false,
      }))
      builtinsCache = { at: Date.now(), list }
      return list
    })().finally(() => {
      builtinsInflight = null
    })
  }
  return builtinsInflight
}

/** The built-in commands: the curated fallback unioned with whatever the bundle scan adds. */
function discoverBuiltins(): Promise<CommandHit[]> {
  if (builtinsCache) {
    // Once there is a list, always answer from it instantly. A stale one is refreshed in the
    // background so no request ever waits on the scan after the first.
    if (Date.now() - builtinsCache.at >= BUILTINS_TTL) void refreshBuiltins()
    return Promise.resolve(builtinsCache.list)
  }
  return refreshBuiltins()
}

// Warm the cache at startup so the first `/` in the browser is not the one that pays for
// the bundle scan.
void discoverBuiltins()

/** Split a file into its YAML-ish frontmatter and the body that follows it. */
function frontmatter(text: string): { meta: Record<string, string>; body: string } {
  if (!text.startsWith('---')) return { meta: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { meta: {}, body: text }
  const head = text.slice(3, end)
  const meta: Record<string, string> = {}
  for (const line of head.split('\n')) {
    const at = line.indexOf(':')
    if (at === -1) continue
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key) meta[key] = value
  }
  // Skip the closing `---` and its newline.
  const rest = text.slice(end + 4)
  return { meta, body: rest.startsWith('\n') ? rest.slice(1) : rest }
}

/** A short description drawn from frontmatter, or the first meaningful line of the body. */
function describe(meta: Record<string, string>, body: string): string {
  if (meta.description) return meta.description
  for (const raw of body.split('\n')) {
    const line = raw.replace(/^#+\s*/, '').trim()
    if (line && !line.startsWith('---')) return line.length > 120 ? `${line.slice(0, 117)}…` : line
  }
  return ''
}

async function isDir(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory()
  } catch {
    return false
  }
}

/** Every `.md` file under a `commands/` root, named the way the CLI invokes it. */
async function readCommandDir(root: string, source: string): Promise<Entry[]> {
  const out: Entry[] = []
  const walk = async (dir: string): Promise<void> => {
    let items: import('node:fs').Dirent[]
    try {
      items = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      const full = path.join(dir, item.name)
      if (item.isDirectory()) {
        await walk(full)
      } else if (item.isFile() && item.name.endsWith('.md')) {
        const rel = path.relative(root, full).replace(/\.md$/, '')
        // Sub-directories namespace the command: `gsd/plan-phase.md` → `gsd:plan-phase`.
        const name = rel.split(path.sep).join(':')
        let text = ''
        try {
          text = await fs.readFile(full, 'utf8')
        } catch {
          continue
        }
        const { meta, body } = frontmatter(text)
        out.push({
          name,
          description: describe(meta, body),
          kind: 'command',
          source,
          runnable: true,
          argHint: meta['argument-hint'] || undefined,
          file: full,
        })
      }
    }
  }
  await walk(root)
  return out
}

/** Every skill under a `skills/` root, named by its directory. */
async function readSkillsDir(root: string, source: string): Promise<Entry[]> {
  let dirs: import('node:fs').Dirent[]
  try {
    dirs = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: Entry[] = []
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const file = path.join(root, dir.name, 'SKILL.md')
    let text = ''
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    const { meta, body } = frontmatter(text)
    out.push({
      name: meta.name || dir.name,
      description: describe(meta, body),
      kind: 'skill',
      source,
      runnable: true,
      file,
    })
  }
  return out
}

/** Commands and skills from the plugins enabled in `~/.claude/settings.json`. */
async function pluginEntries(): Promise<Entry[]> {
  const home = os.homedir()
  let enabled: string[] = []
  try {
    const raw = JSON.parse(await fs.readFile(path.join(home, '.claude', 'settings.json'), 'utf8')) as {
      enabledPlugins?: Record<string, boolean>
    }
    enabled = Object.entries(raw.enabledPlugins ?? {})
      .filter(([, on]) => on)
      .map(([key]) => key)
  } catch {
    return []
  }

  const out: Entry[] = []
  for (const key of enabled) {
    const [name, marketplace] = key.split('@')
    if (!name || !marketplace) continue
    const base = path.join(home, '.claude', 'plugins', 'marketplaces', marketplace)
    // Layout varies between marketplaces, so try the common roots and fall back to the
    // marketplace directory itself (some keep skills directly under it).
    const candidates = [path.join(base, 'plugins', name), path.join(base, 'external_plugins', name)]
    let root = ''
    for (const candidate of candidates) {
      if (await isDir(candidate)) {
        root = candidate
        break
      }
    }
    if (!root) {
      if (await isDir(base)) root = base
      else continue
    }
    out.push(...(await readCommandDir(path.join(root, 'commands'), `plugin:${name}`)))
    out.push(...(await readSkillsDir(path.join(root, 'skills'), `plugin:${name}`)))
  }
  return out
}

/** Every command and skill available to a session, deduped by name. */
async function enumerate(cwd: string): Promise<Entry[]> {
  const hit = cache.get(cwd)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.entries

  const home = os.homedir()
  const [groups, discovered] = await Promise.all([
    Promise.all([
      readCommandDir(path.join(cwd, '.claude', 'commands'), 'project'),
      readSkillsDir(path.join(cwd, '.claude', 'skills'), 'project'),
      readCommandDir(path.join(home, '.claude', 'commands'), 'user'),
      readSkillsDir(path.join(home, '.claude', 'skills'), 'user'),
      pluginEntries(),
    ]),
    discoverBuiltins(),
  ])

  const builtins: Entry[] = discovered.map((hit) => ({ ...hit, file: '' }))

  // Earlier sources win a name collision, so a project command shadows a built-in of the
  // same name and a real skill is never hidden behind a terminal command.
  const seen = new Set<string>()
  const entries: Entry[] = []
  for (const entry of [...groups.flat(), ...builtins]) {
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    entries.push(entry)
  }

  cache.set(cwd, { at: Date.now(), entries })
  return entries
}

/** True when every character of `query` appears in `text`, in order. */
function subsequence(query: string, text: string): boolean {
  let at = 0
  for (const char of query) {
    at = text.indexOf(char, at)
    if (at === -1) return false
    at += 1
  }
  return true
}

/**
 * Score one entry against a query, or 0 to reject it.
 *
 * A match on the name always beats a match on the description, and the weaker match kinds
 * are gated behind a minimum query length. That gate is what keeps a one- or two-character
 * query from dragging in noise: typing `/e` should surface `/effort` and `/exit` (name
 * prefix), not `/cancel-ralph` (the letter `e` merely appears inside it).
 */
function score(query: string, entry: Entry): number {
  const name = entry.name.toLowerCase()
  const desc = entry.description.toLowerCase()
  const len = query.length

  let base: number
  if (name === query) base = 1000
  else if (name.startsWith(query)) base = 820
  else if (len >= 2 && name.includes(query)) base = 620
  else if (len >= 2 && subsequence(query, name)) base = 380
  else if (len >= 3 && desc.includes(query)) base = 180
  else if (len >= 4 && subsequence(query, desc)) base = 70
  else return 0

  // On an equal match, prefer your own skills and commands over a terminal-only built-in,
  // and a shorter name over a longer one.
  if (entry.runnable) base += 15
  return base - Math.min(40, entry.name.length) / 4
}

/**
 * Skills, slash commands, and built-ins matching a `/` query, best first, in one list.
 *
 * They are ranked together rather than split, so a built-in that matches what you typed sits
 * among the results the way it does in the CLI — badged `terminal`, but not hidden away.
 */
export async function searchCommands(cwd: string, query: string, limit = 12): Promise<CommandSearch> {
  const entries = await enumerate(cwd)
  const needle = query.trim().toLowerCase()

  let ranked: Entry[]
  if (!needle) {
    // A bare `/` leads with your own skills and commands, then the built-ins, alphabetical
    // within each group — the things you defined are the likelier target.
    ranked = [...entries].sort(
      (a, b) => Number(b.runnable) - Number(a.runnable) || a.name.localeCompare(b.name),
    )
  } else {
    ranked = entries
      .map((entry) => ({ entry, value: score(needle, entry) }))
      .filter((scored) => scored.value > 0)
      .sort((a, b) => b.value - a.value || a.entry.name.localeCompare(b.entry.name))
      .map((scored) => scored.entry)
  }

  // Drop the internal `file` field from the wire shape.
  return { hits: ranked.slice(0, limit).map(({ file: _file, ...hit }) => hit) }
}

/** Fill a command body's argument placeholders, mirroring the CLI's substitution. */
function fillArgs(body: string, args: string): string {
  const parts = args.length ? args.split(/\s+/) : []
  const hasPlaceholder = body.includes('$ARGUMENTS') || /\$[1-9]/.test(body)
  let out = body.replace(/\$ARGUMENTS/g, args).replace(/\$([1-9])/g, (_, digit) => parts[Number(digit) - 1] ?? '')
  // A command with no placeholder still receives its arguments, appended, as the CLI does.
  if (args && !hasPlaceholder) out = `${out.trimEnd()}\n\n${args}`
  return out.trim()
}

/**
 * Expand a leading `/command` into the text to deliver, mirroring the CLI.
 *
 *   - `null` — the text is not a known slash command; deliver it unchanged.
 *   - `terminal-only` — a built-in the terminal owns; the caller should refuse with a note.
 *   - `expanded` — the prompt to deliver in place of the `/command`.
 */
export async function expandCommand(
  cwd: string,
  text: string,
): Promise<
  | { status: 'expanded'; text: string; name: string; kind: 'skill' | 'command' }
  | { status: 'terminal-only'; name: string }
  | null
> {
  const match = text.match(/^\/(\S+)\s*([\s\S]*)$/)
  if (!match) return null
  const name = match[1] as string
  const args = (match[2] ?? '').trim()

  const entries = await enumerate(cwd)
  const entry = entries.find((candidate) => candidate.name === name)
  if (!entry) return null
  if (entry.kind === 'builtin') return { status: 'terminal-only', name }

  if (entry.kind === 'skill') {
    // A skill is loaded and executed by the receiving model, so the faithful delivery is a
    // clear request to invoke it — which loads its SKILL.md the same way the CLI does.
    const body = args ? `Invoke the \`${name}\` skill with:\n\n${args}` : `Invoke the \`${name}\` skill.`
    return { status: 'expanded', text: body, name, kind: 'skill' }
  }

  let raw = ''
  try {
    raw = await fs.readFile(entry.file, 'utf8')
  } catch {
    return null
  }
  const { body } = frontmatter(raw)
  const expanded = fillArgs(body, args)
  if (!expanded) return null
  return { status: 'expanded', text: expanded, name, kind: 'command' }
}
