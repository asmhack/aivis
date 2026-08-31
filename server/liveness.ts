import { runBounded, type BoundedOptions, type CommandRunner } from './bounded.ts'

/** A running `claude` process and the directory it works in. */
export interface LiveProcess {
  pid: number
  cwd: string
  /** Command line arguments, which reveal flags such as `--resume` or `--ide`. */
  args: string
  /** Elapsed run time as reported by `ps`, for example `09-04:03:55`. */
  elapsed: string
}

/** One `claude` process as `ps` reported it, before its working directory is known. */
export interface PsCandidate {
  pid: number
  elapsed: string
  args: string
}

/**
 * The seams this module is tested through.
 *
 * The parsers below are pure and can be fed text, but the layer above them — which decides
 * whether the fleet reports any live process at all, and what it does when a command does not
 * come back — is only reachable by spawning real processes unless the runner is injectable.
 * That layer is the one that matters most: an empty answer from it silences every session on
 * the machine.
 */
export interface ScanOptions {
  run?: CommandRunner
  now?: () => number
  log?: (message: string) => void
}

let cache: { at: number; processes: LiveProcess[] } | null = null

/**
 * The last working directory `lsof` actually reported for each pid.
 *
 * Only ever written from `lsof` output, never from the fallback below, so a directory that
 * could not be confirmed can be reused but can never breed: a pid that vanishes from `ps`
 * loses its entry, and one whose directory was guessed is guessed from the same confirmed
 * reading each time rather than from the previous guess.
 */
let confirmedCwds = new Map<number, string>()

/** Whether the last `ps` scan worked, so a failure is reported once rather than every tick. */
let psWorking = true
/** Whether directories are currently being carried over from the last confirmed `lsof`. */
let carryingCwds = false

/**
 * Bounds on the two commands this module shells out to.
 *
 * `lsof` stats the path behind every descriptor it reports, so a stale NFS mount or a wedged
 * FUSE volume parks it in the kernel for as long as the mount stays broken, and that matters
 * here more than anywhere else in the server: the fleet refresh awaits this module before it
 * does anything else. What is done about that lives in `bounded.ts`, which every call that can
 * hang goes through.
 */
const COMMAND_TIMEOUT_MS = 5000
const ABANDON_AFTER_MS = 8000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/** Forget every cached reading. For tests, which must not inherit one another's state. */
export function forgetLiveProcesses(): void {
  cache = null
  confirmedCwds = new Map()
  psWorking = true
  carryingCwds = false
}

/**
 * List the `claude` processes running on this machine, with each one's working
 * directory.
 *
 * The working directory comes from `lsof`, which is queried once for every process
 * at a time rather than once per process. Results are cached briefly because the
 * fleet view refreshes far more often than processes start and stop.
 */
export async function liveProcesses(maxAgeMs = 4000, options: ScanOptions = {}): Promise<LiveProcess[]> {
  const now = options.now ?? Date.now
  const log = options.log ?? ((message: string): void => console.error(message))
  if (cache && now() - cache.at < maxAgeMs) return cache.processes

  const ps = await runBounded('ps', ['-eo', 'pid=,etime=,args='], bounds(options))
  if (ps.failed) {
    // Reporting nothing is deliberate here rather than serving the previous scan: these pids
    // are what the end-session and message routes act on, so a list of processes that could
    // not be confirmed to still exist is worse than no list. The answer is not cached, so the
    // next tick asks again as soon as the cooldown in `bounded.ts` allows it.
    //
    // The routes downstream cannot currently tell this apart from a genuinely quiet machine,
    // which is why it is said out loud: an empty fleet during an outage is the reason a
    // message may start a second process, or an end may report success without signalling
    // anything.
    if (psWorking) {
      psWorking = false
      log('[aivis] the process scan failed; no session will read as live until it works again')
    }
    return []
  }
  psWorking = true

  const candidates = parsePs(ps.stdout)
  const pids = candidates.map((c) => c.pid)
  const lsof = await workingDirectories(pids, options)

  // Anything lsof itself reported is now the confirmed reading, and a pid that has left the
  // process table takes its entry with it so the map cannot grow without bound.
  const alive = new Set(pids)
  for (const pid of confirmedCwds.keys()) if (!alive.has(pid)) confirmedCwds.delete(pid)
  for (const [pid, cwd] of lsof.cwds) confirmedCwds.set(pid, cwd)

  const processes: LiveProcess[] = []
  let carried = 0
  for (const c of candidates) {
    let cwd = lsof.cwds.get(c.pid)
    if (!cwd && lsof.failed) {
      // lsof could not answer, rather than answering that this process has gone: `ps` listed
      // the pid moments ago and a session's working directory does not move, so the last
      // directory lsof confirmed for it is a better answer than dropping it. Dropping it would
      // empty the fleet for every session on the machine, including all the ones that have
      // nothing to do with whatever wedged the command.
      cwd = confirmedCwds.get(c.pid)
      if (cwd) carried += 1
    }
    if (cwd) processes.push({ pid: c.pid, cwd, args: c.args, elapsed: c.elapsed })
  }

  if (carried > 0 && !carryingCwds) {
    carryingCwds = true
    log(`[aivis] lsof could not be read; ${carried} process(es) keep the directory it last reported`)
  } else if (carried === 0) {
    carryingCwds = false
  }

  cache = { at: now(), processes }
  return processes
}

/** The same bounds for both commands, with the caller's seams threaded through. */
function bounds(options: ScanOptions): BoundedOptions {
  return {
    maxBuffer: MAX_OUTPUT_BYTES,
    timeoutMs: COMMAND_TIMEOUT_MS,
    abandonAfterMs: ABANDON_AFTER_MS,
    run: options.run,
    now: options.now,
    log: options.log,
  }
}

/**
 * Pick the `claude` processes out of `ps -eo pid=,etime=,args=` output.
 *
 * The three columns are the pid, the elapsed time and the whole command line. `ps` pads them
 * differently on macOS and Linux and widens the first as pids grow, so the split is on runs of
 * whitespace rather than on fixed columns; the elapsed field is taken as written because its
 * shape varies with age, from `05:23` to `09-04:03:55`. A line that is not a numbered process
 * line — a header, a blank line, the trailing newline — fails to match and is skipped.
 */
export function parsePs(stdout: string): PsCandidate[] {
  const candidates: PsCandidate[] = []
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/)
    if (!match) continue
    const [, pidText, elapsed, args] = match as unknown as [string, string, string, string]
    if (!isClaudeProcess(args)) continue
    const pid = Number(pidText)
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    candidates.push({ pid, elapsed, args: args.trim() })
  }
  return candidates
}

/** Runtimes that a `#!/usr/bin/env node` launcher leaves standing in front of the real script. */
const RUNTIMES = new Set(['node', 'nodejs', 'bun', 'deno'])

function fileName(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1)
}

/**
 * The arguments a `claude` command line carries, or null when it is not the `claude` binary.
 *
 * Only the executable decides the answer and never the arguments after it, because the word
 * `claude` turns up as an ordinary file name all over a developer's process table: `vim
 * ~/bin/claude` and `grep claude /var/log/system.log` both name it in a position that means
 * something entirely different, and this predicate decides which pids the end-session route is
 * allowed to signal. A leading JavaScript runtime is stepped over along with its own flags,
 * since an install whose launcher is a `#!/usr/bin/env node` script appears as
 * `node /usr/bin/claude`.
 *
 * `ps` gives no quoting, so an install under a path containing a space reads exactly like a
 * command followed by an argument and is not recognised. That direction is the safe one to be
 * wrong in when the answer decides which processes may be stopped.
 */
export function claudeArguments(args: string): string[] | null {
  const tokens = args.trim().split(/\s+/)
  let index = 0
  if (RUNTIMES.has(fileName(tokens[0] ?? ''))) {
    index = 1
    while (index < tokens.length && (tokens[index] ?? '').startsWith('-')) index += 1
  }
  if (fileName(tokens[index] ?? '') !== 'claude') return null
  return tokens.slice(index + 1)
}

/** Whether a command line belongs to the `claude` binary itself. */
export function isClaudeProcess(args: string): boolean {
  return claudeArguments(args) !== null
}

/** What `lsof` had to say about a set of pids, and whether it managed to say all of it. */
interface Directories {
  cwds: Map<number, string>
  /** True when the command did not finish cleanly, so a missing pid may mean nothing at all. */
  failed: boolean
}

/** Map process ids to working directories with a single `lsof` call. */
async function workingDirectories(pids: number[], options: ScanOptions): Promise<Directories> {
  if (pids.length === 0) return { cwds: new Map(), failed: false }
  // lsof exits non-zero when some of the pids have vanished but still prints the rest, so its
  // output is read whether or not the command reported success. `failed` is carried out with
  // it because the caller has to tell "this process is gone" from "lsof never answered".
  const { stdout, failed } = await runBounded(
    'lsof',
    ['-p', pids.join(','), '-a', '-d', 'cwd', '-Fpn'],
    bounds(options),
  )
  const cwds = parseLsof(stdout)
  // Nothing but the pids we asked about can legitimately come back. A pid that was not asked
  // for means the field format was misread — a directory whose own name contains a newline
  // looks exactly like the start of another process block — and a made-up pid is precisely
  // what must never reach the routes that act on one.
  const asked = new Set(pids)
  for (const pid of cwds.keys()) if (!asked.has(pid)) cwds.delete(pid)
  return { cwds, failed }
}

/**
 * Read `lsof -Fpn` output into a map from process id to working directory.
 *
 * `lsof -F` emits one field per line, prefixed by a type character: `p` starts a new process
 * block and `n` gives the path, so the parser tracks the most recent `p`. A block whose path
 * never arrives simply contributes nothing, which is what a process that exited between the
 * `ps` scan and this call looks like. A `p` line that is not a number forgets the pid it was
 * tracking instead of leaving it in place to collect the next path, because filing a directory
 * under the wrong process is how one session ends up pointed at another session's `claude`.
 */
export function parseLsof(stdout: string): Map<number, string> {
  const result = new Map<number, string>()
  let current: number | null = null
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      const pid = Number(line.slice(1))
      current = Number.isSafeInteger(pid) && pid > 0 ? pid : null
    } else if (line.startsWith('n') && current !== null) {
      result.set(current, line.slice(1))
    }
  }
  return result
}
