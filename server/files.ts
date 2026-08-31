import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

import type { FileHit } from '../shared/types.ts'

export type { FileHit }

interface Listing {
  at: number
  files: FileHit[]
  /** True when the list was cut off, so results may be incomplete. */
  truncated: boolean
}

const MAX_FILES = 60000
const CACHE_MS = 20000
const cache = new Map<string, Listing>()

const PRUNED = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.cache',
  'target',
]

/**
 * List the files under a working directory.
 *
 * A git repository is listed with `git ls-files`, which is fast and already honours
 * `.gitignore`, so build output and dependencies never reach the picker. Anything else
 * falls back to `find` with the usual heavy directories pruned by hand.
 */
async function listFiles(cwd: string): Promise<Listing> {
  const hit = cache.get(cwd)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit

  let lines: string[] = []
  try {
    const { stdout } = await run(
      'git',
      ['-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard'],
      { maxBuffer: 64 * 1024 * 1024, timeout: 10000 },
    )
    lines = stdout.split('\n')
  } catch {
    try {
      // The prune group must be closed before `-prune`, then ORed with the print branch:
      // `find DIR \( -name a -o -name b \) -prune -o -type f -print`. Putting -prune
      // inside the group instead ANDs it with -print, and the command lists nothing.
      const names = PRUNED.flatMap((name, index) => (index === 0 ? ['-name', name] : ['-o', '-name', name]))
      const { stdout } = await run(
        'find',
        [cwd, '(', ...names, ')', '-prune', '-o', '-type', 'f', '-print'],
        { maxBuffer: 64 * 1024 * 1024, timeout: 10000 },
      )
      lines = stdout.split('\n').map((line) => (line.startsWith(cwd) ? line.slice(cwd.length + 1) : line))
    } catch {
      lines = []
    }
  }

  const files: FileHit[] = []
  for (const line of lines) {
    const rel = line.trim()
    if (!rel || rel.startsWith('.git/')) continue
    files.push({ path: rel, name: path.basename(rel), dir: path.dirname(rel) === '.' ? '' : path.dirname(rel) })
    if (files.length >= MAX_FILES) break
  }

  const listing: Listing = { at: Date.now(), files, truncated: files.length >= MAX_FILES }
  cache.set(cwd, listing)
  return listing
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
 * Score one file against a query, or return 0 to reject it.
 *
 * The name is worth more than the directory, because typing `@tier` means the file
 * called that, not every file under a folder whose name contains it. Shorter paths win
 * ties, which keeps a file near the root above a deeply nested one of the same name.
 */
function score(query: string, file: FileHit): number {
  const name = file.name.toLowerCase()
  const full = file.path.toLowerCase()

  let base = 0
  if (name === query) base = 1000
  else if (name.startsWith(query)) base = 800
  else if (name.includes(query)) base = 640
  else if (full.includes(query)) base = 460
  else if (subsequence(query, name)) base = 300
  else if (subsequence(query, full)) base = 140
  else return 0

  // Prefer shallow, short paths, but never enough to outrank a better kind of match.
  return base - Math.min(120, file.path.length) / 2 - file.path.split('/').length * 3
}

/**
 * Find files matching an `@` query, best first.
 *
 * An empty query lists the shallowest files, which is what makes a bare `@` useful.
 */
export async function searchFiles(
  cwd: string,
  query: string,
  limit = 12,
): Promise<{ hits: FileHit[]; total: number; truncated: boolean }> {
  const listing = await listFiles(cwd)
  const needle = query.trim().toLowerCase()

  if (!needle) {
    const hits = [...listing.files]
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))
      .slice(0, limit)
    return { hits, total: listing.files.length, truncated: listing.truncated }
  }

  const scored: { file: FileHit; value: number }[] = []
  for (const file of listing.files) {
    const value = score(needle, file)
    if (value > 0) scored.push({ file, value })
  }
  scored.sort((a, b) => b.value - a.value || a.file.path.localeCompare(b.file.path))
  return {
    hits: scored.slice(0, limit).map((entry) => entry.file),
    total: scored.length,
    truncated: listing.truncated,
  }
}
