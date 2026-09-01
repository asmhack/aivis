import { promises as fs } from 'node:fs'
import path from 'node:path'

import { config } from './config.ts'
import { elapsedMs, type LiveProcess } from './liveness.ts'

/**
 * Which process is running which session, from Claude Code's own record of it.
 *
 * A transcript names its working directory and never the process id that writes it, so for
 * every session aivis reaches — a message over its socket, an end that signals it — the
 * question "which of these processes is this conversation" had only ever been answered by
 * guessing: within a directory, pair the most recently active transcripts with the live
 * processes there, one each. That is right whenever a directory holds one session and wrong
 * almost every other time. On a machine with six sessions open in one checkout it was wrong
 * for all six, and the failure is silent — the receiving session drops a message whose
 * `session_id` is not its own, the socket having already accepted the bytes, so aivis reports
 * a delivery that no session will ever record.
 *
 * Claude Code answers the question itself. Every session writes `~/.claude/sessions/<pid>.json`
 * naming the session id that process is currently running, updates it when the id changes —
 * `/clear` and a resume both make a new one — and removes it on a clean exit. Reading it turns
 * the guess into a fact wherever the file is there.
 *
 * Two things are checked before an entry is believed, because a file is not a process. The pid
 * has to be one of the live `claude` processes the same scan found, so a record left behind by
 * a session that was killed outright cannot resurrect it; and the start time recorded in the
 * file has to match the start time the process reports, so a pid the operating system has
 * since recycled is not mistaken for the one that was recorded under it. An entry that fails
 * either check is dropped rather than repaired: the caller falls back to the guess, which is
 * where it was before this file existed.
 */

/** One session, as the client running it recorded itself. */
export interface RegisteredSession {
  pid: number
  sessionId: string
  cwd: string
  /** Epoch milliseconds the process started, or `null` when the record did not say. */
  startedAt: number | null
  /** The socket the session listens on, named by the client rather than derived here. */
  socketPath: string | null
}

/**
 * How far the recorded start time may sit from the observed one.
 *
 * `ps` reports elapsed time to the second and the reading is up to a few seconds old by the
 * time it is compared, so the two never agree exactly. A minute is far more slack than that
 * needs and still refuses the case this is for: a pid handed to a new process, which starts
 * long after the record that named it was written.
 */
const MAX_START_DRIFT_MS = 60_000

/** How long a reading of the directory is reused, in step with the process scan's own cache. */
const CACHE_MS = 2000

let cache: { dir: string; at: number; entries: RegisteredSession[] } | null = null

/** Forget the cached reading. For tests, which must not inherit one another's state. */
export function forgetRegistry(): void {
  cache = null
}

/**
 * Read every record in the directory, dropping any that is not one.
 *
 * A file that cannot be read or parsed is skipped rather than failing the scan: this is one
 * process reading another's bookkeeping, so a half-written file is an ordinary thing to meet
 * and the answer for it is to leave that session to the guess.
 */
export async function readRegistry(dir: string = config.sessionsDir): Promise<RegisteredSession[]> {
  if (cache && cache.dir === dir && Date.now() - cache.at < CACHE_MS) return cache.entries
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const entries: RegisteredSession[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as Record<string, unknown>
    } catch {
      continue
    }
    const pid = typeof record.pid === 'number' ? record.pid : NaN
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : ''
    const cwd = typeof record.cwd === 'string' ? record.cwd : ''
    if (!Number.isInteger(pid) || pid <= 0 || !sessionId) continue
    entries.push({
      pid,
      sessionId,
      cwd,
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : null,
      socketPath: typeof record.messagingSocketPath === 'string' ? record.messagingSocketPath : null,
    })
  }
  cache = { dir, at: Date.now(), entries }
  return entries
}

/**
 * The records that describe a process this scan can actually see, by session id.
 *
 * Both halves of the answer matter to the caller. A session id that is in here is attributed
 * exactly, and — just as important — a pid that is in here belongs to the session named beside
 * it and must not be offered to any other, even when that session's transcript is not among
 * the ones being placed.
 */
export async function registeredSessions(
  processes: LiveProcess[],
  now: () => number = Date.now,
  dir: string = config.sessionsDir,
): Promise<Map<string, RegisteredSession>> {
  const live = new Map(processes.map((proc) => [proc.pid, proc]))
  const byId = new Map<string, RegisteredSession>()
  for (const entry of await readRegistry(dir)) {
    const proc = live.get(entry.pid)
    if (!proc) continue
    if (!startsAgree(entry, proc, now())) continue
    // Two live records for one session id should not happen — the client removes the old one
    // when it exits — but if it does, the more recently started process is the one still
    // running the conversation.
    const held = byId.get(entry.sessionId)
    if (held && (held.startedAt ?? 0) >= (entry.startedAt ?? 0)) continue
    byId.set(entry.sessionId, entry)
  }
  return byId
}

/** Whether the process running under this pid is the one the record was written for. */
function startsAgree(entry: RegisteredSession, proc: LiveProcess, now: number): boolean {
  // A record without a start time, or a process whose elapsed column `ps` gave in a shape this
  // does not read, is accepted on the pid alone: the check is there to catch a recycled pid,
  // and refusing everything it cannot check would throw away the attribution it is guarding.
  if (entry.startedAt === null) return true
  const ran = elapsedMs(proc.elapsed)
  if (ran === null) return true
  return Math.abs(now - ran - entry.startedAt) <= MAX_START_DRIFT_MS
}

/**
 * Where to write to reach a session, given the process running it.
 *
 * The client records the path it is actually listening on, which is not always the one this
 * would derive: the directory carries the user id beside it on a shared `/tmp`, and Termux
 * puts it somewhere else entirely. The derived path is the fallback for a process with no
 * record, which is the same path aivis used before there was one to read.
 */
export async function socketFor(pid: number, dir: string = config.sessionsDir): Promise<string> {
  const entry = (await readRegistry(dir)).find((record) => record.pid === pid)
  return entry?.socketPath ?? path.join('/tmp/cc-socks', `${pid}.sock`)
}
