import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { claudeArguments, isClaudeProcess, liveProcesses } from './liveness.ts'

const run = promisify(execFile)

/**
 * Finishing a session: stopping the `claude` process behind it so it reads as ended.
 *
 * This is the one irreversible thing aivis does, and where it rests on an attribution rather
 * than on a fact, it says so. A transcript records its working directory but never the process
 * id that writes it, and a `claude` process exposes neither its session id in its arguments
 * nor its transcript in its open files. Current clients record the pairing themselves — see
 * `server/registry.ts` — and where that record exists the process being signalled is the one
 * that said it is running this conversation. Where it does not, a directory holding more than
 * one live session leaves aivis guessing, so `endSession` refuses the ambiguous case unless
 * the caller passes `force`, and the interface says why.
 *
 * Because the pids arrive from a machine-wide `ps` scan rather than from anything aivis
 * started, a wrong guess can land on a process that has nothing to do with the session, and
 * the checks below draw the line under which a wrong guess stops being survivable. aivis
 * never signals itself or anything it is running under, never signals a headless `claude` —
 * a `--print` run, or a tooling subcommand such as `claude mcp serve` — that it did not start
 * itself, and never signals a process that is not the `claude` binary. Each of those refusals
 * is reported with its reason instead of passing silently, because a session that would not
 * end is something the caller has to be told about.
 *
 * Every signal is preceded by re-reading the process, so a pid that has already exited and
 * been recycled by the operating system is never signalled by mistake.
 */

/** How long a process gets to leave on SIGTERM, and how often it is looked at meanwhile. */
const GRACE_MS = 3000
const POLL_MS = 150

/** A parent chain is a few links deep; the cap makes a `ps` that lies terminate anyway. */
const MAX_ANCESTRY_DEPTH = 32

/**
 * Why a pid aivis was asked to stop was left alone instead.
 *
 * These strings leave the server. The `/end` route answers with the outcome below as its
 * body, and the session page has a sentence for each reason, so somebody whose request
 * stopped nothing is told which process aivis declined and why rather than watching a
 * button appear to work. The browser matches on the string instead of importing this union,
 * because the bundle does not reach into the server: a reason added here therefore still
 * reads as itself in an older page, but until it is given a sentence in `END_REFUSALS` in
 * web/components/SessionPage.tsx it is phrased in aivis's words rather than the reader's.
 */
export type SkipReason =
  /** Not a number that can name a running process: fractional, negative, or the kernel's own. */
  | 'implausible-pid'
  /** The same pid twice in one request; it was dealt with the first time. */
  | 'repeated'
  /** The aivis server itself. */
  | 'aivis-itself'
  /** A process aivis is running under, up to and including the terminal that launched it. */
  | 'aivis-ancestor'
  /** It exited between the scan and the signal. */
  | 'already-gone'
  /** Something else now holds that pid, or the scan matched a file merely named `claude`. */
  | 'not-claude'
  /** A headless `claude` — a `--print` run, or `claude mcp serve` and its like — that aivis
   * did not start: tooling, not a session anybody is sitting at. */
  | 'non-interactive'
  /** The signal itself was refused, most often because the process had just left. */
  | 'signal-failed'

/** One pid that was not signalled, and what stopped it. */
export interface SkippedProcess {
  pid: number
  reason: SkipReason
}

export interface EndOutcome {
  ended: boolean
  /** Processes that exited on SIGTERM. */
  stopped: number[]
  /** Processes that ignored SIGTERM and had to be killed. */
  forced: number[]
  /** Processes left alone, each with the reason it was left alone. */
  skipped: SkippedProcess[]
}

export interface Ambiguity {
  /** Live `claude` processes sharing this session's working directory. */
  processes: number[]
  /** Sessions in that directory aivis currently believes are live. */
  liveSessions: number
}

/** Send a signal to a process, throwing the way `process.kill` does when it is not there. */
type Kill = (pid: number, signal: NodeJS.Signals | 0) => void

/**
 * What the caller knows that this module cannot read for itself, and the seams it is tested
 * through.
 *
 * Every step that reads or signals a process is a parameter with a real default, because the
 * test for these guards must not be able to signal a process on the machine running it: the
 * accident this code exists to prevent is precisely the one its own suite would otherwise
 * risk causing. Waiting is a seam for the same reason in reverse — the escalation window is
 * three seconds, and a test should spend it without spending the time.
 */
export interface EndOptions {
  /**
   * Pids aivis spawned itself.
   *
   * A driven session is aivis's own child, so its identity is known rather than guessed, and
   * it is allowed past the headless refusal below that its own launch flags would otherwise
   * trip. It is allowed past nothing else: the pid was recorded when the child started and
   * the operating system may have handed it to somebody else since, so it still has to read
   * as a live `claude` process at the moment of the signal. A child aivis started but can no
   * longer name is recognised by its parent link instead, in `someoneElsesTool` below.
   */
  owned?: number[]
  /** Read a process's command line, or null when it is gone. */
  argsOf?: (pid: number) => Promise<string | null>
  /** Read a process's parent, or null when it is gone or `ps` said something unreadable. */
  ppidOf?: (pid: number) => Promise<number | null>
  kill?: Kill
  sleep?: (ms: number) => Promise<void>
  /** How long a process gets to leave on SIGTERM before it is killed. */
  graceMs?: number
  /** How often it is looked at while that window runs. */
  pollMs?: number
}

/** Read a process's arguments, or null when it is gone. */
async function argsOfProcess(pid: number): Promise<string | null> {
  try {
    const { stdout } = await run('ps', ['-o', 'args=', '-p', String(pid)], { timeout: 4000 })
    const args = stdout.trim()
    return args.length > 0 ? args : null
  } catch {
    return null
  }
}

/** Read a process's parent, or null when it is gone. */
async function ppidOfProcess(pid: number): Promise<number | null> {
  // Node knows its own parent without asking anybody, and that is the link that matters most:
  // it is the shell, editor or `claude --print` that started aivis.
  if (pid === process.pid) return process.ppid > 0 ? process.ppid : null
  try {
    const { stdout } = await run('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 4000 })
    const parent = Number(stdout.trim())
    return Number.isSafeInteger(parent) && parent > 0 ? parent : null
  } catch {
    return null
  }
}

/**
 * The processes aivis is running under, nearest first.
 *
 * aivis is usually started from a terminal, an editor, or a `claude` session that is driving
 * it, and every one of those is a process a `ps` scan can offer up as a candidate to stop.
 * Stopping one takes aivis down with it and destroys whatever that parent was in the middle
 * of, so the whole chain is read once and excluded. A chain that cannot be read all the way
 * up ends early rather than guessing: the links that were readable are still excluded, and
 * the remaining checks stand on their own.
 */
async function ancestorsOf(pid: number, ppidOf: (pid: number) => Promise<number | null>): Promise<Set<number>> {
  const chain = new Set<number>()
  let current = pid
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth += 1) {
    const parent = await ppidOf(current)
    // Stop at init, and at a loop: a `ps` that reports a process as its own ancestor must not
    // be able to keep this walking.
    if (parent === null || parent <= 1 || chain.has(parent)) break
    chain.add(parent)
    current = parent
  }
  return chain
}

/**
 * Names Claude Code answers to that run a tool rather than a conversation.
 *
 * `claude mcp serve` is the one that makes this necessary: a `.mcp.json` entry pointing at it
 * is started with the project root as its working directory and stays up for as long as the
 * editor that launched it, which is exactly the shape the attribution behind these pids
 * matches on — a long-lived `claude` in a directory full of transcripts, carrying no `--print`
 * to give itself away. The rest are here because they are the same kind of thing and cost
 * nothing to list.
 *
 * The list is deliberately not exhaustive and deliberately not verified against a particular
 * release: a subcommand it has not heard of falls back to the `--print` test, and a session
 * whose opening prompt happens to begin with one of these words is refused when it should not
 * have been. That is the direction to be wrong in — a refusal costs the user a `/exit` in
 * their own terminal, and stopping the wrong process cannot be undone.
 */
const TOOL_SUBCOMMANDS = new Set([
  'mcp',
  'gateway',
  'serve',
  'config',
  'doctor',
  'install',
  'update',
  'migrate-installer',
  'setup-token',
  'plugin',
  'plugins',
  'agents',
])

/**
 * Whether a `claude` command line is headless tooling rather than somebody's session.
 *
 * `--print` (`-p`) is how scripts, editor integrations, aivis's own drivers and the harness
 * that audits aivis all run Claude Code: they take a prompt, print an answer and exit, with
 * nobody sitting at them and often no resumable transcript behind them. Such a process is
 * never the session a user asked to end, but it does share the working directory of whatever
 * repository it was pointed at, which is the one thing the attribution behind these pids
 * actually matches on — so it is exactly the process a wrong guess lands on. A tooling
 * subcommand is the same story with none of the evidence, so the first word that is not a
 * flag is checked against the list above.
 *
 * The flag is looked for anywhere on the line rather than only in the position a parser would
 * accept it, which over-refuses by design, and a command line that is not `claude` at all is
 * not this function's to judge — the caller has already refused it as `not-claude`.
 */
function isNonInteractive(args: string): boolean {
  const rest = claudeArguments(args)
  if (rest === null) return false
  if (rest.some((token) => token === '--print' || token === '-p' || token.startsWith('--print='))) {
    return true
  }
  const subcommand = rest.find((token) => !token.startsWith('-'))
  return subcommand !== undefined && TOOL_SUBCOMMANDS.has(subcommand)
}

/** Whether a process is still there, asked without touching it. */
function isAlive(pid: number, kill: Kill): boolean {
  try {
    // Signal 0 tests for the process without signalling it.
    kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Whether this session's directory holds more than one live session.
 *
 * When it does, aivis cannot say which process writes which transcript, so ending one is a
 * guess that could stop the wrong conversation.
 */
export async function ambiguityFor(cwd: string, liveSessionsInCwd: number): Promise<Ambiguity | null> {
  const processes = (await liveProcesses(0)).filter((proc) => proc.cwd === cwd).map((proc) => proc.pid)
  if (processes.length <= 1 && liveSessionsInCwd <= 1) return null
  return { processes, liveSessions: liveSessionsInCwd }
}

/**
 * Stop the processes behind a session.
 *
 * SIGTERM first, so Claude Code can close its transcript and release its socket the way it
 * would on `/exit`; SIGKILL only for a process that ignores it. A pid that does not survive
 * the checks above is reported in `skipped` and never signalled, so a request that ends
 * nothing comes back saying so rather than appearing to have worked.
 */
export async function endSession(pids: number[], options: EndOptions = {}): Promise<EndOutcome> {
  const argsOf = options.argsOf ?? argsOfProcess
  const ppidOf = options.ppidOf ?? ppidOfProcess
  const kill =
    options.kill ??
    ((pid, signal): void => {
      process.kill(pid, signal)
    })
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const graceMs = options.graceMs ?? GRACE_MS
  // A poll interval of zero would turn the wait below into a loop that never advances.
  const pollMs = Math.max(1, options.pollMs ?? POLL_MS)
  const owned = new Set(options.owned ?? [])

  const stopped: number[] = []
  const forced: number[] = []
  const skipped: SkippedProcess[] = []
  const skip = (pid: number, reason: SkipReason): void => {
    skipped.push({ pid, reason })
  }

  const seen = new Set<number>()
  // Reading the ancestry costs a `ps` per link, so it is read once per call, and only once a
  // pid has got far enough to be worth checking against it.
  let ancestry: Set<number> | null = null

  /**
   * Whether a headless `claude` is somebody else's to stop.
   *
   * Two of them are not. One is a driver the caller named in `owned`. The other is a driver
   * the caller could not name: `DriverRegistry` forgets a driver the moment its status turns
   * to exited or error, and a start that timed out never registered one at all, so a child
   * aivis spawned can still be running with nothing in memory pointing at it. Its parent link
   * says so without any bookkeeping, and it cannot say so wrongly — a process whose parent is
   * this server is a process this server started. It stops saying so once the daemon has
   * restarted, because an orphan is reparented to init; ending one of those needs its pid to
   * have been written down somewhere that survives the restart.
   */
  const someoneElsesTool = async (pid: number, args: string): Promise<boolean> => {
    if (!isNonInteractive(args)) return false
    if (owned.has(pid)) return false
    return (await ppidOf(pid)) !== process.pid
  }

  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      skip(pid, 'implausible-pid')
      continue
    }
    if (seen.has(pid)) {
      skip(pid, 'repeated')
      continue
    }
    seen.add(pid)
    if (pid === process.pid) {
      skip(pid, 'aivis-itself')
      continue
    }
    ancestry ??= await ancestorsOf(process.pid, ppidOf)
    if (ancestry.has(pid)) {
      skip(pid, 'aivis-ancestor')
      continue
    }
    // Re-read rather than trust the scan: a pid recorded seconds ago may already be gone,
    // and the operating system reuses pids.
    const args = await argsOf(pid)
    if (args === null) {
      skip(pid, 'already-gone')
      continue
    }
    if (!isClaudeProcess(args)) {
      skip(pid, 'not-claude')
      continue
    }
    if (await someoneElsesTool(pid, args)) {
      skip(pid, 'non-interactive')
      continue
    }

    try {
      kill(pid, 'SIGTERM')
    } catch {
      skip(pid, 'signal-failed')
      continue
    }

    // Give it a moment to leave on its own terms before insisting.
    let gone = false
    for (let waited = 0; waited < graceMs; waited += pollMs) {
      await sleep(pollMs)
      if (!isAlive(pid, kill)) {
        gone = true
        break
      }
    }

    if (gone) {
      stopped.push(pid)
      continue
    }

    // SIGKILL costs the process whatever it was in the middle of, so the pid is read once more
    // before it is sent. The probe in the loop above only asks whether *something* holds that
    // number, and three seconds is long enough for a session to have exited and the operating
    // system to have handed its number to a build step or an editor — which is the whole
    // reason the SIGTERM was preceded by the same reading.
    const holder = await argsOf(pid)
    if (holder === null) {
      // It left, just after the window closed. SIGTERM did the work; nothing else is owed.
      stopped.push(pid)
      continue
    }
    if (!isClaudeProcess(holder)) {
      skip(pid, 'not-claude')
      continue
    }
    if (await someoneElsesTool(pid, holder)) {
      skip(pid, 'non-interactive')
      continue
    }

    try {
      kill(pid, 'SIGKILL')
      forced.push(pid)
    } catch {
      skip(pid, 'signal-failed')
    }
  }

  return { ended: stopped.length + forced.length > 0, stopped, forced, skipped }
}
