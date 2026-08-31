import { execFile, type ChildProcess } from 'node:child_process'

/**
 * Running something that is not guaranteed to come back.
 *
 * The fleet refresh is a single chain of awaits — the process scan, then a settings read and a
 * `git` call per directory — and the server skips a tick while the previous refresh is still in
 * flight, so any one of those calls that never settles stops every session view on the machine
 * from updating until the daemon is restarted. The thing that makes them not settle is the
 * same in each case: a stale NFS mount or a wedged FUSE volume parks the work in the kernel,
 * where a process sits in an uninterruptible state that no signal reaches.
 *
 * A `timeout` alone does not close that, because Node reacts to one by signalling the child and
 * then waiting for the child to exit, which is exactly what a process in uninterruptible sleep
 * will not do. So each call here gets three layers: `timeout` for a command that is merely
 * slow, `killSignal: 'SIGKILL'` for one that ignores SIGTERM, and a wall-clock deadline that
 * stops waiting on its own for one the kernel will not let die at all.
 *
 * Abandoning is not free. The child is still there, still holding the three pipes the parent
 * opened for it, so `release()` below drops the parent's side of them and lets the process go
 * unreferenced; and because whatever wedged the command is almost certainly still wedged, a
 * command that had to be abandoned is left alone for a cooldown that doubles with each
 * consecutive abandonment rather than being respawned every few seconds. Without that, a mount
 * that stays broken would strand a new stuck process on every scan until the daemon ran out of
 * file descriptors, which is a worse failure than the freeze this replaces.
 */

/** Whatever a command printed, and whether it finished cleanly. */
export interface CommandOutput {
  /** The output, which is worth reading even when the command exited non-zero: `lsof` reports
   * failure when some of the pids it was asked about have gone yet still prints the rest. */
  stdout: string
  /** True when the command did not finish cleanly, so its output may be partial or missing. */
  failed: boolean
}

/** A command in flight, and the means to stop waiting for it. */
export interface BoundedCommand {
  done: Promise<CommandOutput>
  /** Drop the parent's side of the child's pipes; the child itself may never exit. */
  release: () => void
}

/** How a command is actually started. Injected by tests so nothing is spawned. */
export type CommandRunner = (
  command: string,
  args: string[],
  options: { maxBuffer: number; timeoutMs: number },
) => BoundedCommand

export interface BoundedOptions {
  /** How long the command may run before it is signalled. */
  timeoutMs?: number
  /** How long the caller waits for the signal to work before giving up on the answer. */
  abandonAfterMs?: number
  maxBuffer?: number
  /**
   * What the cooldown is remembered against.
   *
   * `lsof` wedging says nothing about `ps`, and one repository on a broken mount says nothing
   * about the others, so the key is the command by default and the caller narrows it when it
   * can name the thing that might be broken.
   */
  key?: string
  run?: CommandRunner
  now?: () => number
  log?: (message: string) => void
}

/** The first pause after a command had to be abandoned, and the longest it grows to. */
const FIRST_COOLDOWN_MS = 15_000
const MAX_COOLDOWN_MS = 300_000

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_ABANDON_AFTER_MS = 8000

interface Stall {
  /** No further attempt against this key before this moment. */
  until: number
  /** How long the last pause was, which the next one doubles. */
  wait: number
}

const stalls = new Map<string, Stall>()

/** Forget every cooldown. For tests, which must not inherit one another's state. */
export function forgetStalls(): void {
  stalls.clear()
}

/** A value only this module can produce, so a deadline is never mistaken for real output. */
const ABANDONED = Symbol('abandoned')

function spawnBounded(
  command: string,
  args: string[],
  options: { maxBuffer: number; timeoutMs: number },
): BoundedCommand {
  let child: ChildProcess | null = null
  const done = new Promise<CommandOutput>((resolve) => {
    child = execFile(
      command,
      args,
      { maxBuffer: options.maxBuffer, timeout: options.timeoutMs, killSignal: 'SIGKILL' },
      (err, stdout) => {
        resolve({ stdout: typeof stdout === 'string' ? stdout : '', failed: err !== null })
      },
    )
  })

  return {
    done,
    release: () => {
      const streams = [child?.stdin, child?.stdout, child?.stderr]
      for (const stream of streams) {
        if (!stream) continue
        // Tearing down a pipe whose other end is still open can surface as an error event, and
        // an unhandled one on a stream would take the server down over a command it had
        // already given up on.
        stream.on('error', () => {})
        stream.destroy()
      }
      // The child may outlive us; it must not be a reason for the process to stay alive.
      child?.unref()
    },
  }
}

/**
 * Run a read-only command that must never be able to block the caller indefinitely.
 *
 * Failure is reported rather than thrown, because every caller here has something sensible to
 * do with "no answer" and nothing sensible to do with an exception.
 */
export async function runBounded(
  command: string,
  args: string[],
  options: BoundedOptions = {},
): Promise<CommandOutput> {
  const now = options.now ?? Date.now
  const run = options.run ?? spawnBounded
  const log = options.log ?? ((message: string): void => console.error(message))
  const key = options.key ?? command
  const abandonAfterMs = options.abandonAfterMs ?? DEFAULT_ABANDON_AFTER_MS

  const previous = stalls.get(key)
  if (previous && now() < previous.until) return { stdout: '', failed: true }

  const attempt = run(command, args, {
    maxBuffer: options.maxBuffer ?? 1024 * 1024,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  })

  let abandoned = false
  const settled = attempt.done.then(
    (result) => {
      // A command that came back at all clears the escalation, so a mount that recovers is
      // scanned at full speed again from the next tick.
      if (!abandoned) stalls.delete(key)
      return result
    },
    () => ({ stdout: '', failed: true }),
  )

  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<typeof ABANDONED>((resolve) => {
    timer = setTimeout(() => resolve(ABANDONED), abandonAfterMs)
    // A pending deadline is no reason to hold the process open.
    timer.unref()
  })

  let outcome: CommandOutput | typeof ABANDONED
  try {
    outcome = await Promise.race([settled, deadline])
  } finally {
    clearTimeout(timer)
  }
  if (outcome !== ABANDONED) return outcome

  abandoned = true
  attempt.release()
  // Nobody is waiting for this any more, so nothing must be able to turn its eventual answer
  // into an unhandled rejection.
  void settled.catch(() => {})

  const wait = Math.min(previous ? previous.wait * 2 : FIRST_COOLDOWN_MS, MAX_COOLDOWN_MS)
  stalls.set(key, { until: now() + wait, wait })
  log(`[aivis] ${command} did not return within ${abandonAfterMs}ms; not asking again for ${wait}ms`)
  return { stdout: '', failed: true }
}

/**
 * Give up on a promise that has taken too long, and carry on with `fallback`.
 *
 * For work that is not a subprocess and so cannot be signalled at all — `fs.readFile` on a
 * wedged mount is the one that matters here. The read stays pending and keeps its worker
 * thread; the point is only that the caller is no longer part of it.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  // The abandoned work must not become an unhandled rejection once nobody is awaiting it.
  void work.catch(() => {})
  let timer: NodeJS.Timeout | undefined
  const expiry = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
    timer.unref()
  })
  try {
    return await Promise.race([work, expiry])
  } finally {
    clearTimeout(timer)
  }
}
