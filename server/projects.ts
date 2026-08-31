import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Turn `~/x` or a relative path into an absolute one. */
export function resolveDir(input: string): string {
  const trimmed = input.trim()
  const expanded = trimmed.startsWith('~') ? path.join(os.homedir(), trimmed.slice(1)) : trimmed
  return path.resolve(expanded)
}

/** Create a directory if it is missing. Returns true when it had to be created. */
export async function ensureDir(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir)
    if (!stat.isDirectory()) throw new Error(`${dir} exists but is not a directory`)
    return false
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    await fs.mkdir(dir, { recursive: true })
    return true
  }
}

/** Claude Code's config file, of which aivis reads and writes one flag under `projects`. */
interface ClaudeConfig {
  projects?: Record<string, Record<string, unknown>>
  [key: string]: unknown
}

/**
 * The tail of the trust writes already queued, which is how they are kept one at a time.
 *
 * `ParkedRegistry.save` collapses concurrent saves into whichever write is already running,
 * because it rebuilds its whole file from memory and any writer therefore carries everyone's
 * changes. Nothing like that holds here: each call carries the folder it is about in its
 * arguments, so collapsing two calls would silently drop one of the folders. They are queued
 * instead, and each one reads, changes and replaces the file with no other call inside it.
 */
let trustQueue: Promise<unknown> = Promise.resolve()

/** Run something once every trust write queued before it has finished, failed or not. */
function queued<T>(work: () => Promise<T>): Promise<T> {
  const next = trustQueue.then(work)
  // The tail everyone waits on must never reject, or one failed call would wedge the rest.
  trustQueue = next.catch(() => {})
  return next
}

/**
 * Read the config, or null when there is nothing there worth changing.
 *
 * A missing file means Claude Code has never run for this user, and a body that is not a
 * JSON object is either half-written by somebody else or not the file we think it is. In
 * both cases aivis writes nothing, because a config it invented would be worse than a
 * folder that still asks about trust.
 */
async function readConfig(file: string): Promise<{ raw: string; config: ClaudeConfig } | null> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return { raw, config: parsed as ClaudeConfig }
  } catch {
    return null
  }
}

/**
 * Enough of a file's identity to notice that somebody else has written it.
 *
 * The inode catches a replacement by rename, which is how every careful writer — including
 * this one — puts a new config in place, and leaves the old inode untouched. Size and
 * modification time catch a writer that truncates and rewrites in place instead. Together
 * they miss only a rewrite that lands on the same inode, at the same byte length, inside one
 * tick of the filesystem's timestamp resolution, which is nanoseconds on both APFS and ext4.
 */
interface ConfigStamp {
  mtimeMs: number
  size: number
  ino: number
}

/** The stamp of a file, or null when it cannot be stat'd — which counts as having moved. */
async function stampConfig(file: string): Promise<ConfigStamp | null> {
  try {
    const stat = await fs.stat(file)
    return { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino }
  } catch {
    return null
  }
}

function sameStamp(a: ConfigStamp | null, b: ConfigStamp | null): boolean {
  return a !== null && b !== null && a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino
}

/**
 * How many times a trust write starts over when the config moved under it.
 *
 * Each retry is one read of the file, so a handful of them is cheap, and a config being
 * rewritten by somebody else that often is a config aivis should stop pushing against.
 */
const TRUST_WRITE_ATTEMPTS = 3

/**
 * Mark a directory as trusted in Claude Code's own config.
 *
 * Claude Code asks whether to trust a folder the first time an interactive session opens
 * there, and records the answer as `projects[<dir>].hasTrustDialogAccepted`. Print mode
 * never asks, so a session aivis starts would run fine while the same folder still
 * stopped you at a prompt the moment you took it into a terminal with `copy resume`.
 * Writing the flag here keeps the handoff seamless, and covers every later session in
 * that folder, because the flag is per directory rather than per session.
 *
 * The whole config is rewritten, since JSON has no safe partial edit. A copy is kept at
 * `~/.claude.json.aivis-backup` the first time, and the new file is written beside the
 * original under a name no other call can pick and then renamed over it, so neither an
 * interrupted write nor a second write at the same moment can truncate it.
 *
 * That file is not aivis's to own, though: every running `claude` writes it too, and this
 * rewrite could throw one of those writes away by putting back everything as it stood when
 * the read happened. Three things narrow that window as far as one process can. Calls are
 * queued, so aivis is never racing itself, and the copy that is changed is read after the
 * backup has been taken rather than before, so what lands is the newest content this
 * process saw. A re-read that comes back missing or unparsable abandons the write outright,
 * because a stale snapshot is exactly what must not be written over somebody else's file.
 * And the file is stamped when it is read and stamped again immediately before the rename:
 * if it moved in between, the temp file is thrown away and the whole read-change-write
 * starts over, so the unguarded gap is a stat and a rename rather than a full serialise and
 * write of a config that can run to megabytes. The gap cannot be closed altogether without
 * a lock every other writer agrees to honour, and there is none, but a few microseconds is
 * a different thing from the tens of milliseconds a large config would otherwise sit open.
 * The stamp is taken before the read rather than after, because a write that lands between
 * the two then shows up as a difference and costs a retry, where the other order would let
 * the newest stamp vouch for content that was read before it.
 *
 * `home` is here so that tests can point the whole thing at a temp directory; every caller
 * in the server leaves it alone and gets the real one.
 */
export async function trustProject(
  dir: string,
  home: string = os.homedir(),
): Promise<{ trusted: boolean; alreadyTrusted: boolean }> {
  const configPath = path.join(home, '.claude.json')
  const backupPath = path.join(home, '.claude.json.aivis-backup')

  return queued(async () => {
    const before = await readConfig(configPath)
    if (!before) return { trusted: false, alreadyTrusted: false }
    if (before.config.projects?.[dir]?.hasTrustDialogAccepted === true) {
      return { trusted: true, alreadyTrusted: true }
    }

    // The backup is the config as it stood before aivis had ever changed it, so it is
    // written once and never touched again.
    try {
      await fs.access(backupPath)
    } catch {
      await fs.writeFile(backupPath, before.raw)
    }

    for (let attempt = 0; attempt < TRUST_WRITE_ATTEMPTS; attempt++) {
      const stamp = await stampConfig(configPath)
      const latest = await readConfig(configPath)
      if (!latest || !stamp) return { trusted: false, alreadyTrusted: false }
      const projects = latest.config.projects ?? {}
      const existing = projects[dir]
      if (existing?.hasTrustDialogAccepted === true) return { trusted: true, alreadyTrusted: true }
      projects[dir] = { ...(existing ?? {}), hasTrustDialogAccepted: true }
      latest.config.projects = projects

      const temp = `${configPath}.aivis-${process.pid}-${randomUUID()}`
      try {
        await fs.writeFile(temp, JSON.stringify(latest.config, null, 2))
        // Somebody else wrote the config while this one was being serialised, so what is
        // in the temp file is already out of date and renaming it would undo their write.
        if (!sameStamp(stamp, await stampConfig(configPath))) {
          await fs.rm(temp, { force: true }).catch(() => {})
          continue
        }
        await fs.rename(temp, configPath)
      } catch (err) {
        // A temp file left behind would sit next to the real config for ever, so it goes
        // even when the failure that stranded it is passed on to the caller.
        await fs.rm(temp, { force: true }).catch(() => {})
        throw err
      }
      return { trusted: true, alreadyTrusted: false }
    }
    // Something else is writing the config continuously. Not trusting the folder only
    // means the terminal asks about it once; overwriting whatever that writer is saving
    // is the outcome worth avoiding, so the write is given up rather than forced through.
    return { trusted: false, alreadyTrusted: false }
  })
}

/** Git branches in a directory, and whether switching is safe. */
export interface BranchState {
  isRepo: boolean
  current: string | null
  branches: string[]
  /** False when the working tree has uncommitted changes. */
  clean: boolean
}

export async function branchState(dir: string): Promise<BranchState> {
  const empty: BranchState = { isRepo: false, current: null, branches: [], clean: true }
  try {
    const { stdout: current } = await run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 4000,
    })
    const { stdout: list } = await run(
      'git',
      ['-C', dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'],
      { timeout: 4000 },
    )
    const { stdout: status } = await run('git', ['-C', dir, 'status', '--porcelain'], { timeout: 6000 })
    return {
      isRepo: true,
      current: current.trim() || null,
      branches: list.split('\n').map((b) => b.trim()).filter(Boolean),
      clean: status.trim().length === 0,
    }
  } catch {
    return empty
  }
}

/**
 * What no branch name may look like, whatever the repository happens to contain.
 *
 * Git reads an argument beginning with a dash as an option wherever it sits in argv, so
 * `--orphan=evil` or `-Bmain` would be obeyed rather than looked up, and a control
 * character cannot occur in a real ref at all. Neither can come from the branch picker,
 * which offers what `branchState` listed, so both are refused before git is asked anything.
 */
const UNUSABLE_BRANCH = /^-|\p{Cc}/u

/** What every rejected branch name is reported as, since none of them is worth explaining. */
const NOT_A_BRANCH_NAME = 'that is not a usable branch name'

/**
 * Check out a branch before a session starts.
 *
 * Every session in a directory shares one working tree, so switching branches moves the
 * ground under any session already running there. A dirty tree is refused outright
 * rather than stashed, because losing track of someone's uncommitted work is worse than
 * making them do it themselves.
 *
 * The name arrives in the request body, so it is treated as something somebody typed rather
 * than something the picker offered. Only a name the repository already lists as a local
 * branch is accepted, git is then asked to confirm it is a well-formed branch name, and the
 * switch puts it after `--end-of-options` so that a name which somehow got past both checks
 * still could not be read as a flag. `git switch` does that job rather than `git checkout`
 * because `checkout -- <name>` would make git read the name as a path instead of a branch;
 * both `switch` and `--end-of-options` have been in git since 2.24, released in 2019.
 */
export async function checkoutBranch(dir: string, branch: string): Promise<string | null> {
  if (!branch || UNUSABLE_BRANCH.test(branch)) return NOT_A_BRANCH_NAME
  const state = await branchState(dir)
  if (!state.isRepo) return 'not a git repository'
  if (state.current === branch) return null
  if (!state.branches.includes(branch)) return 'no branch of that name exists here'
  if (!state.clean) return 'the working tree has uncommitted changes'
  try {
    await run('git', ['-C', dir, 'check-ref-format', '--branch', branch], { timeout: 4000 })
  } catch {
    return NOT_A_BRANCH_NAME
  }
  try {
    await run('git', ['-C', dir, 'switch', '--no-guess', '--end-of-options', branch], {
      timeout: 15000,
    })
    return null
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err).slice(0, 200)
  }
}

/** One directory offered by the folder browser. */
export interface BrowseEntry {
  name: string
  path: string
  /** True when the directory already holds a git repository. */
  isRepo: boolean
}

/** List the sub-directories of a path, for picking a project folder. */
export async function browse(dir: string): Promise<{ path: string; parent: string | null; entries: BrowseEntry[] }> {
  const target = resolveDir(dir || os.homedir())
  const listing = await fs.readdir(target, { withFileTypes: true })
  const entries: BrowseEntry[] = []
  for (const entry of listing) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const full = path.join(target, entry.name)
    let isRepo = false
    try {
      await fs.access(path.join(full, '.git'))
      isRepo = true
    } catch {
      // Not a repository, which is fine — any folder can hold a session.
    }
    entries.push({ name: entry.name, path: full, isRepo })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  const parent = path.dirname(target)
  return { path: target, parent: parent === target ? null : parent, entries }
}
