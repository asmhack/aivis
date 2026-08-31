/**
 * What a session changed on disk.
 *
 * The transcript already says which files a session edited, but not what the working tree
 * looks like now: a file removed with `rm`, or edited in a terminal beside the agent,
 * leaves no tool call behind. So the file list here comes from git, which is the only
 * thing that knows the current state, and the diffs come from git too, with real line
 * numbers on both sides.
 *
 * Everything is scoped to the session's working directory with `--relative`, so a session
 * running in a subdirectory of a large repository reports its own corner of it rather than
 * the whole tree, and the paths it reports resolve against the directory it runs in.
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ChangeBase, ChangeSet, ChangedFile, DiffHunk, FileChange, HunkLine } from '../shared/types.ts'

const run = promisify(execFile)

/** Several sessions often share a directory, and a page refetches on every new turn. */
const CACHE_MS = 4000
const cache = new Map<string, { at: number; set: ChangeSet }>()

/** Untracked files are counted by reading them, so the list is bounded. */
const MAX_UNTRACKED = 400
const UNTRACKED_MAX_BYTES = 4 * 1024 * 1024

/** Beyond this a single file's diff is cut short rather than sent whole. */
const MAX_DIFF_LINES = 6000

/**
 * How long before the session's first record a file may have been written and still count
 * as its work. Some filesystems keep mtimes to the whole second, so a file written a
 * fraction of a second after the session began can carry a timestamp a fraction before it,
 * and a rounding difference should not cost a file its place in the list.
 */
const MTIME_GRACE_MS = 2000

/**
 * Run git in a directory.
 *
 * `git diff --no-index` exits 1 when the files differ, which is the normal case rather
 * than a failure, so a caller that expects that passes `keepOutput`.
 */
async function git(cwd: string, args: string[], keepOutput = false): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], {
      maxBuffer: 48 * 1024 * 1024,
      timeout: 15000,
    })
    return stdout
  } catch (err) {
    const partial = (err as { stdout?: string }).stdout
    if (keepOutput && typeof partial === 'string') return partial
    throw err
  }
}

interface BaseCommit {
  short: string
  subject: string
  at: string
}

async function commitMeta(cwd: string, rev: string): Promise<BaseCommit | null> {
  try {
    const out = await git(cwd, ['show', '-s', '--format=%h%x00%cI%x00%s', rev])
    const [short, at, subject] = out.split('\0')
    if (!short) return null
    return { short: short.trim(), at: (at ?? '').trim(), subject: (subject ?? '').trim() }
  } catch {
    return null
  }
}

/**
 * The commit a base names.
 *
 * `start` is the newest commit reachable from HEAD that was made before the session's
 * first record. That is the base that keeps answering "what did this session change" once
 * the session has committed its own work, which `HEAD` stops doing the moment it commits.
 * A session older than every commit has nothing to sit behind it, so it falls back to HEAD
 * and says so rather than reporting the whole repository as new.
 */
async function baseFor(
  cwd: string,
  base: 'start' | 'head',
  startedAt: string,
): Promise<{ meta: BaseCommit | null; fellBack: boolean }> {
  if (base === 'head') return { meta: await commitMeta(cwd, 'HEAD'), fellBack: false }

  let rev = ''
  try {
    rev = (await git(cwd, ['rev-list', '-1', `--before=${startedAt}`, 'HEAD'])).trim()
  } catch {
    rev = ''
  }
  if (!rev) return { meta: await commitMeta(cwd, 'HEAD'), fellBack: true }
  return { meta: await commitMeta(cwd, rev), fellBack: false }
}

interface StatusEntry {
  status: ChangedFile['status']
  oldPath: string | null
  similarity: number | null
}

/**
 * Parse `git diff --name-status -z`.
 *
 * Records are `M\0path\0`, and a rename is `R098\0old\0new\0` — three fields, not two —
 * which is exactly why `-z` is used: the human-readable form quotes and abbreviates paths
 * in ways that cannot be undone reliably.
 */
function parseNameStatus(out: string): Map<string, StatusEntry> {
  const fields = out.split('\0')
  const map = new Map<string, StatusEntry>()
  let i = 0
  while (i < fields.length) {
    const code = fields[i]
    i += 1
    if (!code) continue
    const letter = code[0]
    if (letter === 'R' || letter === 'C') {
      const from = fields[i] ?? ''
      const to = fields[i + 1] ?? ''
      i += 2
      if (to) {
        map.set(to, { status: 'renamed', oldPath: from || null, similarity: Number(code.slice(1)) || null })
      }
      continue
    }
    const file = fields[i] ?? ''
    i += 1
    if (!file) continue
    const status = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified'
    map.set(file, { status, oldPath: null, similarity: null })
  }
  return map
}

/**
 * Parse `git diff --numstat -z`.
 *
 * A record is `added\tremoved\tpath`, and a rename leaves the path field empty and follows
 * it with the old and new paths as their own records. A binary file reports `-` for both
 * counts, because there are no lines to count.
 */
function parseNumstat(out: string): Map<string, { added: number; removed: number; binary: boolean }> {
  const fields = out.split('\0')
  const map = new Map<string, { added: number; removed: number; binary: boolean }>()
  let i = 0
  while (i < fields.length) {
    const record = fields[i]
    i += 1
    if (!record) continue
    const firstTab = record.indexOf('\t')
    const secondTab = record.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue

    const addText = record.slice(0, firstTab)
    const removeText = record.slice(firstTab + 1, secondTab)
    const binary = addText === '-' || removeText === '-'
    const counts = {
      added: binary ? 0 : Number(addText) || 0,
      removed: binary ? 0 : Number(removeText) || 0,
      binary,
    }

    const file = record.slice(secondTab + 1)
    if (file === '') {
      // A rename: the old and new paths are the next two records.
      const to = fields[i + 1] ?? ''
      i += 2
      if (to) map.set(to, counts)
    } else {
      map.set(file, counts)
    }
  }
  return map
}

/** True when a buffer looks like something other than text. */
function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0)
}

/** How many lines git would count in a new file: a trailing newline does not open one. */
function lineCount(text: string): number {
  if (text === '') return 0
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
}

/**
 * The moment before which a change cannot be this session's, or null when the base is not
 * asking that question.
 *
 * `start` means "what did this session change", and the base commit only anchors half of
 * that answer. A file left uncommitted or untracked days ago differs from that commit too,
 * so without a second anchor the list reports work nobody did in this session — a fresh
 * session in a repository with an untidy working tree opens on dozens of files at its first
 * tool call. `head` means "what is uncommitted, whoever wrote it", which is a question
 * about the tree rather than the session, so it takes no cutoff.
 */
function cutoff(base: 'start' | 'head', startedAt: string): number | null {
  if (base !== 'start') return null
  const at = Date.parse(startedAt)
  return Number.isFinite(at) ? at - MTIME_GRACE_MS : null
}

/** True unless the file is still carrying an mtime from before the session started. */
async function writtenSince(full: string, since: number): Promise<boolean> {
  try {
    const stat = await fs.stat(full)
    return stat.mtimeMs >= since
  } catch {
    // Deleted, or unreadable: there is no mtime left to judge it by, and dropping a
    // deletion the session made is the worse of the two mistakes.
    return true
  }
}

/**
 * Tracked changes minus the ones that were already there when the session started.
 *
 * Nothing in git records when a working-tree edit happened — a commit has a date, an
 * uncommitted edit does not — so the file's own mtime is the only witness, and a file last
 * written before the session began cannot be its doing.
 */
async function changedSince(cwd: string, files: ChangedFile[], since: number): Promise<ChangedFile[]> {
  const kept: ChangedFile[] = []
  // Batched for the same reason the untracked read is: a rebase can leave hundreds of rows.
  for (let start = 0; start < files.length; start += 32) {
    const batch = files.slice(start, start + 32)
    const recent = await Promise.all(
      batch.map((file) => writtenSince(path.join(cwd, file.path), since)),
    )
    batch.forEach((file, at) => {
      if (recent[at]) kept.push(file)
    })
  }
  return kept
}

/**
 * Files git is not tracking yet.
 *
 * A file the session has just written is the most interesting row in the list and git's
 * own diff never mentions it, so it is listed here and its lines are counted by reading
 * it. `--exclude-standard` means `.gitignore` already keeps build output out.
 *
 * A `since` cutoff drops the files that were sitting there untracked before the session
 * started, which are the ones this list gets wrong most often: they never age out of
 * `git ls-files --others` the way an uncommitted edit ages out at the next commit.
 */
async function untrackedFiles(
  cwd: string,
  since: number | null,
): Promise<{ files: ChangedFile[]; capped: boolean; predating: number }> {
  let paths: string[] = []
  try {
    const out = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
    paths = out.split('\0').filter((entry) => entry !== '')
  } catch {
    return { files: [], capped: false, predating: 0 }
  }

  const capped = paths.length > MAX_UNTRACKED
  const wanted = paths.slice(0, MAX_UNTRACKED)
  const files: ChangedFile[] = []
  let predating = 0

  // Batched so a directory of a few hundred new files does not open them all at once.
  for (let start = 0; start < wanted.length; start += 16) {
    const batch = wanted.slice(start, start + 16)
    const read = await Promise.all(
      batch.map(async (rel): Promise<ChangedFile | null> => {
        const row: ChangedFile = {
          path: rel,
          status: 'added',
          added: 0,
          removed: 0,
          oldPath: null,
          similarity: null,
          binary: false,
          untracked: true,
        }
        try {
          const full = path.join(cwd, rel)
          const stat = await fs.stat(full)
          // Older than the session, so it is not this session's file to claim — and not
          // one worth spending a read on either.
          if (since !== null && stat.mtimeMs < since) return null
          // A file too big to hold in memory still belongs in the list; only its count goes.
          if (stat.size > UNTRACKED_MAX_BYTES) return row
          const buffer = await fs.readFile(full)
          if (looksBinary(buffer)) return { ...row, binary: true }
          return { ...row, added: lineCount(buffer.toString('utf8')) }
        } catch {
          return row
        }
      }),
    )
    for (const row of read) {
      if (row === null) predating += 1
      else files.push(row)
    }
  }

  return { files, capped, predating }
}

const EMPTY = (base: ChangeBase): ChangeSet => ({
  base,
  isRepo: false,
  branch: null,
  baseCommit: null,
  baseSubject: null,
  baseAt: null,
  baseFellBack: false,
  files: [],
  untrackedCapped: false,
  predating: 0,
  error: null,
})

/** Churn, which is what the list is ordered by: the biggest change first. */
function churn(file: ChangedFile): number {
  return file.added + file.removed
}

/**
 * Every file that differs between the base and the working tree, biggest change first.
 *
 * Tracked changes come from one `git diff` in two shapes — `--name-status` for what
 * happened to each file, `--numstat` for how much — joined on the path, because neither
 * command carries both halves.
 */
export async function changeSet(cwd: string, base: 'start' | 'head', startedAt: string): Promise<ChangeSet> {
  const key = `${cwd}\0${base}\0${startedAt}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.set

  const set = await readChanges(cwd, base, startedAt)
  cache.set(key, { at: Date.now(), set })
  return set
}

async function readChanges(cwd: string, base: 'start' | 'head', startedAt: string): Promise<ChangeSet> {
  let branch: string | null = null
  try {
    const inside = (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim()
    if (inside !== 'true') return EMPTY(base)
    branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || null
  } catch {
    return EMPTY(base)
  }

  const { meta, fellBack } = await baseFor(cwd, base, startedAt)
  const since = cutoff(base, startedAt)
  const files: ChangedFile[] = []
  let error: string | null = null
  let predating = 0

  if (meta) {
    try {
      const [statusOut, numstatOut] = await Promise.all([
        git(cwd, ['diff', '--name-status', '--find-renames', '--relative', '-z', meta.short]),
        git(cwd, ['diff', '--numstat', '--find-renames', '--relative', '-z', meta.short]),
      ])
      const statuses = parseNameStatus(statusOut)
      const counts = parseNumstat(numstatOut)
      const tracked: ChangedFile[] = []
      for (const [file, entry] of statuses) {
        const count = counts.get(file)
        tracked.push({
          path: file,
          status: entry.status,
          added: count?.added ?? 0,
          removed: count?.removed ?? 0,
          oldPath: entry.oldPath,
          similarity: entry.similarity,
          binary: count?.binary ?? false,
          untracked: false,
        })
      }
      const kept = since === null ? tracked : await changedSince(cwd, tracked, since)
      predating += tracked.length - kept.length
      files.push(...kept)
    } catch (err) {
      error = String(err)
    }
  }

  const untracked = await untrackedFiles(cwd, since)
  files.push(...untracked.files)
  predating += untracked.predating
  files.sort((a, b) => churn(b) - churn(a) || a.path.localeCompare(b.path))

  return {
    base,
    isRepo: true,
    branch,
    baseCommit: meta?.short ?? null,
    baseSubject: meta?.subject ?? null,
    baseAt: meta?.at ?? null,
    baseFellBack: fellBack,
    files,
    untrackedCapped: untracked.capped,
    predating,
    error,
  }
}

/**
 * Reject a path that would reach outside the session's working directory.
 *
 * The path arrives from the browser and goes to git as a pathspec, where it cannot be
 * mistaken for a flag, but it could still climb out of the directory being reported on.
 */
function safePath(rel: string): string | null {
  if (!rel || rel.startsWith('/')) return null
  if (rel.split('/').includes('..')) return null
  return rel
}

/**
 * Turn unified diff text into hunks.
 *
 * Line numbers are read from the `@@` marker and advanced per line, which is the only
 * place they exist: a diff records where a change starts, not where each line landed.
 */
function parseHunks(text: string): { hunks: DiffHunk[]; binary: boolean; truncated: boolean } {
  const hunks: DiffHunk[] = []
  let binary = false
  let truncated = false
  let current: DiffHunk | null = null
  let oldN = 0
  let newN = 0
  let emitted = 0

  for (const line of text.split('\n')) {
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      binary = true
      continue
    }
    if (line.startsWith('@@')) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/)
      if (!match) continue
      oldN = Number(match[1])
      newN = Number(match[2])
      current = {
        header: line.slice(0, line.indexOf('@@', 2) + 2),
        context: (match[3] ?? '').trim(),
        lines: [],
        added: 0,
        removed: 0,
      }
      hunks.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('\\')) continue // "\ No newline at end of file"

    if (emitted >= MAX_DIFF_LINES) {
      truncated = true
      break
    }

    let entry: HunkLine | null = null
    if (line.startsWith('+')) {
      entry = { kind: 'add', oldN: null, newN, text: line.slice(1) }
      newN += 1
      current.added += 1
    } else if (line.startsWith('-')) {
      entry = { kind: 'del', oldN, newN: null, text: line.slice(1) }
      oldN += 1
      current.removed += 1
    } else if (line.startsWith(' ')) {
      entry = { kind: 'ctx', oldN, newN, text: line.slice(1) }
      oldN += 1
      newN += 1
    } else {
      // Anything else ends the hunk: the header of the next file, or the trailing blank.
      current = null
      continue
    }
    current.lines.push(entry)
    emitted += 1
  }

  return { hunks, binary, truncated }
}

/**
 * The diff of one file against a base.
 *
 * A file git is not tracking has no diff to take, so it is compared against nothing with
 * `--no-index`, which produces the same unified output with every line an addition.
 */
export async function fileChange(
  cwd: string,
  base: 'start' | 'head',
  startedAt: string,
  requested: string,
  options: { context: number; ignoreWhitespace: boolean },
): Promise<FileChange> {
  const rel = safePath(requested)
  const context = Math.min(Math.max(Math.round(options.context) || 3, 0), 400)
  const blank: FileChange = {
    path: requested,
    hunks: [],
    binary: false,
    truncated: false,
    context,
    error: null,
  }
  if (!rel) return { ...blank, error: 'that path is outside the session directory' }

  const set = await changeSet(cwd, base, startedAt)
  const entry = set.files.find((file) => file.path === rel)
  const flags = ['-U' + String(context), ...(options.ignoreWhitespace ? ['-w'] : [])]

  try {
    let out: string
    if (entry?.untracked) {
      out = await git(cwd, ['diff', '--no-index', ...flags, '--', '/dev/null', rel], true)
    } else if (set.baseCommit) {
      const paths = entry?.oldPath ? [entry.oldPath, rel] : [rel]
      out = await git(cwd, [
        'diff',
        '--find-renames',
        '--relative',
        ...flags,
        set.baseCommit,
        '--',
        ...paths,
      ])
    } else {
      return { ...blank, path: rel, error: 'this repository has no commit to compare against' }
    }
    const parsed = parseHunks(out)
    // A file with an unresolved merge comes back as a combined diff (`@@@`), whose columns
    // do not mean what they do here. Say so rather than report an empty diff.
    const combined = parsed.hunks.length === 0 && !parsed.binary && out.includes('@@@')
    return {
      path: rel,
      hunks: parsed.hunks,
      binary: parsed.binary,
      truncated: parsed.truncated,
      context,
      error: combined ? 'this file is mid-merge, and a combined diff is not read here' : null,
    }
  } catch (err) {
    return { ...blank, path: rel, error: String(err) }
  }
}
