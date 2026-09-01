import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import { config } from './config.ts'
import { childEnv } from './driver.ts'
import { LOCAL_NAMES } from './origin.ts'
import type { BashRun } from '../shared/types.ts'

/**
 * `!` bash lines: run here, held, and sent as context in front of the next message.
 *
 * The terminal client runs a `!` line itself and writes the result into the transcript
 * without ever calling the model, so the output is there for your next prompt and provokes
 * no reply of its own. Nothing about that travels over the stream-json protocol aivis speaks
 * to a driven session, and nothing about it travels over the message socket a terminal
 * session is reached on either, so aivis has to do the same thing the client does: run the
 * command on this machine and produce the records itself.
 *
 * That the output waits for the next message rather than being sent immediately is the whole
 * design, not a limitation. Every user frame written to a driven session's standard input
 * starts a turn, so sending a run on its own would have the model answer a `!ls` you did not
 * ask it anything about — burning a turn and diverging from the terminal, where `!ls` is
 * silent. Holding it and putting it in front of what you type next reproduces the terminal's
 * semantics exactly, and has a second effect worth having: because a `!` line never touches
 * the child, it works while the session is mid-turn.
 *
 * A run can also be stopped before it is done, which is `stopBashLine` below. A command
 * holds its session's only `!` slot until it is over, so the `!gcloud auth login` you walked
 * away from leaves that session unable to run another line — and the timeout it is waiting on
 * is measured in minutes. Stopping signals the same process group a timeout would, and keeps
 * what the command printed before it was cut off: partial output, marked as partial, is still
 * the truth about what happened.
 *
 * What this module does not do is pretend to be a security boundary. Running a command here
 * is the feature. `bashRefusal` is about which binds it is offered on; see the note on
 * `config.bashLines` for why that is a narrowing rather than a wall.
 */

/** How many `!` commands may be in flight across all sessions at once. */
const MAX_RUNNING = 8

/**
 * How many finished runs may wait on one session before it stops accepting more.
 *
 * They are only released by sending a message, so without a cap a session you never write to
 * would accumulate output until the daemon ran out of memory. Refusing is better than
 * dropping the oldest: output that vanished silently is worse than a command that says it
 * did not run.
 */
const MAX_PENDING = 16

/** A ceiling on the command itself, so a runaway paste cannot become a runaway argv. */
const MAX_COMMAND_CHARS = 8000

/**
 * How long a command that is being killed has to act on SIGTERM before SIGKILL.
 *
 * The signal goes to the process group rather than the process, so a `!sleep 100 | cat` dies
 * whole — signalling only the shell would leave the pipeline behind, still holding the pipe
 * this module is reading and keeping the run from ever finishing.
 */
const KILL_GRACE_MS = 2000

/**
 * How long a stop waits for the run to be over before calling it over regardless.
 *
 * A little past the grace above, so the SIGKILL has been sent and its `close` has had a
 * moment to arrive. Beyond that the process group is gone and the only thing that could still
 * be holding the pipes open is something that left the group — a grandchild that gave itself
 * one — which will never produce a `close`. Waiting on that for ever would leave the session
 * unable to run anything again, which is precisely what the stop was asked for.
 */
const STOP_WAIT_MS = KILL_GRACE_MS + 500

/** Runs waiting to be sent, by session id. Finished and still-running both live here. */
const pending = new Map<string, BashRun[]>()

/** A command in flight, and the handle on it a stop needs. */
interface InFlight {
  run: BashRun
  /** Kill the process group and answer once the run has left the map. */
  stop: () => Promise<void>
}

/** Sessions with a command in flight, so a second `!` cannot interleave with the first. */
const running = new Map<string, InFlight>()

/** What the refusal rule needs to know, so it can be exercised for binds this process is not on. */
export interface BashPolicy {
  /** `AIVIS_BASH`, lowercased: `auto`, `1`, or `0`. */
  mode: string
  /** The address aivis is bound to, as `AIVIS_HOST` gives it. */
  host: string
}

/**
 * Why a `!` line will not run, or `null` when it will.
 *
 * Checked before the command is read rather than after, so a refusal says nothing about what
 * was going to be run. It takes its policy as an argument for the reason `sameOrigin` does:
 * the interesting case is a bind this process is not on, and reaching it by setting an
 * environment variable and re-importing a module is not a test anyone writes twice.
 */
export function bashRefusal(
  policy: BashPolicy = { mode: config.bashLines, host: config.host },
): string | null {
  if (policy.mode === '0' || policy.mode === 'off' || policy.mode === 'false') {
    return '`!` lines are turned off here (AIVIS_BASH=0).'
  }
  if (policy.mode === '1' || policy.mode === 'on' || policy.mode === 'true') return null
  if (!LOCAL_NAMES.has(policy.host.toLowerCase())) {
    return (
      `aivis is bound to ${policy.host}, which is not loopback, and it has no authentication. ` +
      'A `!` line here would be an interactive shell for anyone who can reach the port, so it ' +
      'is refused by default. Set AIVIS_BASH=1 to allow it anyway.'
    )
  }
  return null
}

/** The runs a session is holding, still-running ones included, oldest first. */
export function pendingBash(sessionId: string): BashRun[] {
  return pending.get(sessionId) ?? []
}

/**
 * The runs that are ready to travel with a message.
 *
 * A command still printing is left behind rather than waited for: sending a message should
 * not block on a `!npm test` someone started, and half a run is not context. It goes with
 * whatever message follows it instead.
 */
export function finishedBash(sessionId: string): BashRun[] {
  return pendingBash(sessionId).filter((run) => !run.running)
}

/**
 * Drop runs that have been sent.
 *
 * Taken by id rather than by draining the list, because the send happens between reading the
 * runs and clearing them: a `!` line that finished in that window would otherwise be dropped
 * without ever having been in a message.
 */
export function clearBash(sessionId: string, ids: string[]): void {
  const held = pending.get(sessionId)
  if (!held) return
  const sent = new Set(ids)
  const left = held.filter((run) => !sent.has(run.id))
  if (left.length > 0) pending.set(sessionId, left)
  else pending.delete(sessionId)
}

/** Forget a session's runs, for when the session itself is gone. */
export function forgetBash(sessionId: string): void {
  pending.delete(sessionId)
}

/** What `startBashLine` answers with: the run it started, or the reason it did not. */
export type BashStart = { ok: true; run: BashRun } | { ok: false; status: number; error: string }

/**
 * Start a `!` line in the session's own directory and hold the result.
 *
 * Returns as soon as the command is spawned rather than when it finishes. A `!` line can be
 * a `gcloud auth login` that waits on a browser, and a request held open for that long is a
 * request that gets abandoned by something in the middle and takes the output with it. The
 * run object handed back is the same object the store keeps, so it fills in as the command
 * proceeds and the page sees it finish by re-reading the transcript.
 */
export function startBashLine(sessionId: string, cwd: string, command: string): BashStart {
  const refusal = bashRefusal()
  if (refusal) return { ok: false, status: 403, error: refusal }
  if (!command.trim()) return { ok: false, status: 400, error: 'no command' }
  if (command.length > MAX_COMMAND_CHARS) {
    return { ok: false, status: 400, error: `a command may be at most ${MAX_COMMAND_CHARS} characters` }
  }
  // JSON can carry a NUL that an argv cannot, and `spawn` answers one by throwing
  // synchronously rather than by emitting 'error' — which would leave the route's 500 wrapper
  // reporting a daemon fault for what is an ordinary bad request.
  if (command.includes('\0')) {
    return { ok: false, status: 400, error: 'a command cannot contain a null byte' }
  }
  if (running.has(sessionId)) {
    return { ok: false, status: 409, error: 'a command is already running in this session' }
  }
  if (running.size >= MAX_RUNNING) {
    return { ok: false, status: 429, error: `already running ${MAX_RUNNING} commands; wait for one to finish` }
  }
  if (pendingBash(sessionId).length >= MAX_PENDING) {
    return {
      ok: false,
      status: 429,
      error: `${MAX_PENDING} runs are already waiting to be sent; send a message to flush them`,
    }
  }

  const run: BashRun = {
    id: randomUUID(),
    command,
    at: new Date().toISOString(),
    running: true,
    stdout: '',
    stderr: '',
    exitCode: null,
    truncated: false,
    timedOut: false,
    stopped: false,
    failure: null,
    timeoutMs: config.bashTimeoutMs,
    maxBytes: config.bashMaxOutputBytes,
    durationMs: 0,
  }

  // The shell is the one the operator's own login uses, so the syntax that works in the
  // terminal this replaces works here. `-c` does not read an rc file in any of them, so the
  // command sees the PATH the daemon was started with rather than an interactive one — which
  // is why a tool that is only on the PATH your shell profile builds has to be spawned from a
  // shell that was.
  const shell = process.env.SHELL || '/bin/sh'
  const started = Date.now()

  // `cwd` is the session's own directory, taken from the fleet rather than from the request.
  // Letting the caller name a directory would turn this into "run anything anywhere" with the
  // origin gate as the only thing in the way, and there is no reason a `!` line needs it: the
  // terminal it imitates runs in the session's directory too.
  //
  // stdin is /dev/null rather than a pipe. A command that stops to ask something then reads
  // EOF and fails in a second, where a pipe nobody writes to would leave it blocked until the
  // timeout with nothing on screen to explain why.
  //
  // `detached` puts the command in a process group of its own, which is what makes the
  // timeout able to kill a whole pipeline rather than just the shell in front of it.
  const child = spawn(shell, ['-c', command], {
    cwd,
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })

  pending.set(sessionId, [...pendingBash(sessionId), run])

  const stdout = capture(child.stdout, run)
  const stderr = capture(child.stderr, run)

  const signal = (sig: NodeJS.Signals): void => {
    const pid = child.pid
    if (pid === undefined) return
    // The negative pid is the process group. It fails once the group is gone, which is the
    // ordinary case for the SIGKILL after a SIGTERM that worked.
    try {
      process.kill(-pid, sig)
    } catch {
      try {
        child.kill(sig)
      } catch {
        /* already gone */
      }
    }
  }

  let hard: NodeJS.Timeout | undefined
  const kill = (): void => {
    signal('SIGTERM')
    // Only ever scheduled once: a stop that lands on a run the timeout is already killing
    // adds nothing by asking for a second SIGKILL.
    if (hard) return
    hard = setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS)
    hard.unref()
  }

  const timer = setTimeout(() => {
    run.timedOut = true
    kill()
  }, run.timeoutMs)
  timer.unref()

  /** Resolved by `finish`, so a stop can wait for the run to be over rather than for a signal. */
  let settle = (): void => {}
  const closed = new Promise<void>((resolve) => {
    settle = resolve
  })

  const finish = (): void => {
    clearTimeout(timer)
    if (hard) clearTimeout(hard)
    run.stdout = stdout()
    run.stderr = stderr()
    run.durationMs = Date.now() - started
    run.running = false
    running.delete(sessionId)
    settle()
  }

  /**
   * Stop the command, and answer when it is actually over rather than when it was signalled.
   *
   * The wait is the point. Whoever stopped a run usually wants to run something else in its
   * place, and the session's slot is not free until this run has released it — so returning
   * on the signal would hand the caller a 409 for the command it had just killed.
   */
  const stop = async (): Promise<void> => {
    if (!run.running) return
    run.stopped = true
    kill()
    await Promise.race([closed, wait(STOP_WAIT_MS)])
    if (run.running) finish()
  }

  // The session's slot, held until `finish` gives it back. It carries the stop with it,
  // because reaching this run's process group is something only this call can do.
  running.set(sessionId, { run, stop })

  // A command that could not start — no such shell, a directory that has been deleted — never
  // emits 'close', so its failure is recorded here or the run stays 'running' for ever.
  //
  // Node reports both of those as `spawn <shell> ENOENT`, which names the one thing that is
  // usually fine: a session whose directory has been deleted or was never on this machine
  // reads as a broken shell. The directory is checked here rather than before the spawn
  // because this is diagnosis after the fact, where a stat cannot lose a race that matters.
  child.on('error', (err: Error) => {
    if (!run.running) return
    run.failure =
      (err as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(cwd)
        ? `the session's directory is gone: ${cwd}`
        : err.message
    finish()
  })

  // 'close' rather than 'exit': the pipes are drained by then, so the last of the output is
  // in hand. Waiting for 'exit' would routinely lose the tail of a chatty command.
  child.on('close', (code: number | null) => {
    if (!run.running) return
    run.exitCode = code
    finish()
  })

  return { ok: true, run }
}

/** What `stopBashLine` answers with: the run it stopped, or the reason it stopped nothing. */
export type BashStop = { ok: true; run: BashRun } | { ok: false; status: number; error: string }

/**
 * Stop the `!` command a session is running, if it is still running.
 *
 * `runId` names the run to stop and is checked rather than trusted, because the page asking
 * is up to a poll behind what the daemon knows: a stop clicked on a command that finished
 * meanwhile would otherwise land on whatever was started after it. Passing nothing stops
 * whatever is in flight, which is what a caller with no id in hand means.
 *
 * The run stays where it is once stopped. It is a finished run like any other and goes to the
 * session with the next message, carrying the note that says it was cut short — a `!npm test`
 * you stopped halfway is not a `!npm test` that passed, and the record has to say so.
 */
export async function stopBashLine(sessionId: string, runId?: string | null): Promise<BashStop> {
  const inFlight = running.get(sessionId)
  if (!inFlight) return { ok: false, status: 409, error: 'no command is running in this session' }
  if (runId && inFlight.run.id !== runId) {
    return {
      ok: false,
      status: 409,
      error: 'that command has already finished; the one running now was started after it',
    }
  }
  await inFlight.stop()
  return { ok: true, run: inFlight.run }
}

/** A timer that does not itself keep the process alive, as a promise. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}

/**
 * Read a stream, keeping the first `maxBytes` and counting the rest.
 *
 * What matters here is that it keeps reading after the cap. The child writes into a pipe with
 * a fixed kernel buffer, so a reader that stops reading stops the writer too — a `!cat` of
 * something large would hang until the timeout instead of returning a truncated first slice.
 * Dropping the excess costs nothing; not reading it costs the command.
 */
function capture(stream: NodeJS.ReadableStream, run: BashRun): () => string {
  const chunks: Buffer[] = []
  let bytes = 0
  stream.on('data', (chunk: Buffer) => {
    const room = run.maxBytes - bytes
    if (room <= 0) {
      run.truncated = true
      return
    }
    if (chunk.length > room) {
      chunks.push(chunk.subarray(0, room))
      bytes = run.maxBytes
      run.truncated = true
      return
    }
    chunks.push(chunk)
    bytes += chunk.length
  })
  // Decoding once at the end rather than per chunk, so a multi-byte character split across
  // two reads survives; only one can be cut, the one the cap lands inside.
  return () => Buffer.concat(chunks).toString('utf8')
}
