import { test } from 'node:test'
import assert from 'node:assert/strict'
import { endSession, type EndOptions } from '../server/terminate.ts'

/*
 * Ending a session is the only thing aivis does that cannot be undone, and the pids it acts on
 * come from a machine-wide `ps` scan attributed to transcripts by working directory and
 * recency — a guess. What follows pins the checks that decide when that guess is not good
 * enough to act on: the pid that cannot name a process, the process aivis is running under,
 * the editor with a file called `claude` open, and the headless `claude --print` that some
 * script or harness is in the middle of.
 *
 * Nothing here touches a real process. `endSession` takes every step that reads or signals one
 * as a parameter, and every test injects a machine that exists only in this file, because a
 * suite that proved these guards by signalling live pids would be the accident the guards are
 * there to prevent. Waiting is injected for the opposite reason: the escalation window is
 * three real seconds, and the tests below spend all of it without spending any time.
 */

/** One signal the code under test sent, and how long it had waited by the time it sent it. */
interface Signalled {
  pid: number
  signal: NodeJS.Signals | 0
  waited: number
}

interface Machine {
  /** Every signal sent, including the signal-0 probes that only ask whether a process is there. */
  calls: Signalled[]
  /** Every wait the escalation window asked for, in milliseconds. */
  waits: number[]
  options: EndOptions
}

/**
 * A process table that exists only in this file.
 *
 * A process leaves on SIGTERM the way a `claude` session closing its transcript does, unless
 * it is listed as `stubborn`, in which case only SIGKILL takes it away. `refuses` stands for a
 * process that is gone or out of reach by the moment the signal lands, which the operating
 * system reports by throwing.
 */
function machine(
  processes: Record<number, string>,
  options: {
    stubborn?: number[]
    refuses?: number[]
    parents?: Record<number, number>
    /**
     * What each pid's command line turns into once the grace window has started.
     *
     * A process that leaves during that window frees its number, and the operating system
     * hands numbers out again, so by the time the window closes the pid can belong to
     * somebody else entirely. An empty string is the in-between moment: the number is still
     * held, but `ps` no longer has a command line to give for it.
     */
    becomes?: Record<number, string>
  } = {},
): Machine {
  const live = new Map(Object.entries(processes).map(([pid, args]) => [Number(pid), args]))
  const stubborn = new Set(options.stubborn ?? [])
  const refuses = new Set(options.refuses ?? [])
  const parents = options.parents ?? {}
  const becomes = options.becomes ?? {}
  const calls: Signalled[] = []
  const waits: number[] = []
  const waited = (): number => waits.reduce((total, ms) => total + ms, 0)

  return {
    calls,
    waits,
    options: {
      // An empty command line is a process `ps` can no longer describe, which reads the same
      // way a departed one does.
      argsOf: async (pid) => live.get(pid) || null,
      ppidOf: async (pid) => parents[pid] ?? null,
      sleep: async (ms) => {
        waits.push(ms)
        if (waits.length === 1) {
          for (const [pid, args] of Object.entries(becomes)) live.set(Number(pid), args)
        }
      },
      kill: (pid, signal) => {
        calls.push({ pid, signal, waited: waited() })
        if (refuses.has(pid) || !live.has(pid)) throw new Error('ESRCH: no such process')
        if (signal === 'SIGKILL' || (signal === 'SIGTERM' && !stubborn.has(pid))) live.delete(pid)
      },
    },
  }
}

/** The signals actually sent to a process, without the probes that merely ask after it. */
function signalsTo(world: Machine, pid: number): Signalled[] {
  return world.calls.filter((call) => call.pid === pid && call.signal !== 0)
}

const A_SESSION = '/usr/local/bin/claude --resume 4f0c2a'
const A_SESSION_UNDER_NODE = 'node /Users/dev/.local/bin/claude --ide'

/*
 * The pid filter is the cheapest check and the one a caller is most likely to reach by
 * accident, since `livePids` arrives from a scan that a route hands straight through. 0 is
 * every process in the caller's group, 1 is init, and a fraction or a NaN is a number that
 * never named a process at all.
 */
test('a pid that cannot name a stoppable process is refused before anything is signalled', async () => {
  const world = machine({})
  const outcome = await endSession([0, 1, -1, 1.5, Number.NaN, process.pid], world.options)

  assert.deepEqual(outcome.skipped, [
    { pid: 0, reason: 'implausible-pid' },
    { pid: 1, reason: 'implausible-pid' },
    { pid: -1, reason: 'implausible-pid' },
    { pid: 1.5, reason: 'implausible-pid' },
    { pid: Number.NaN, reason: 'implausible-pid' },
    { pid: process.pid, reason: 'aivis-itself' },
  ])
  // Not merely "no SIGTERM": the kill seam was never reached at all, not even to ask whether
  // one of these was alive.
  assert.deepEqual(world.calls, [])
  assert.equal(outcome.ended, false)
  assert.deepEqual(outcome.stopped, [])
  assert.deepEqual(outcome.forced, [])
})

/*
 * The failure this guards against has actually happened on this machine: aivis is routinely
 * started from a `claude` session, that parent shares the repository directory with every
 * transcript in it, and the attribution behind `livePids` matches on exactly that directory.
 * A parent presented as a candidate looks like an ordinary session — the fixtures below are
 * deliberately indistinguishable from the one that does get stopped further down.
 */
test('a process aivis is running under is refused however convincingly the scan attributed it', async () => {
  const world = machine(
    { 4242: A_SESSION, 77: A_SESSION_UNDER_NODE },
    { parents: { [process.pid]: 4242, 4242: 77, 77: 1 } },
  )
  const outcome = await endSession([4242, 77], world.options)

  assert.deepEqual(outcome.skipped, [
    { pid: 4242, reason: 'aivis-ancestor' },
    { pid: 77, reason: 'aivis-ancestor' },
  ])
  assert.deepEqual(world.calls, [])
  assert.equal(outcome.ended, false)
})

/*
 * A parent chain that cannot be read to the top must not become a reason to signal anything
 * blindly, and a `ps` that reports a process as its own parent must not become a hang.
 */
test('an ancestry that loops on itself still excludes every link it did read', async () => {
  const world = machine({ 4242: A_SESSION }, { parents: { [process.pid]: 4242, 4242: 4242 } })
  const outcome = await endSession([4242], world.options)

  assert.deepEqual(outcome.skipped, [{ pid: 4242, reason: 'aivis-ancestor' }])
  assert.deepEqual(world.calls, [])
})

/*
 * The word `claude` turns up all over a developer's process table in positions that mean
 * something entirely different. The predicate that sorts them is `liveness.isClaudeProcess`,
 * which the scan and this module share so that a pid can never pass one and fail the other;
 * these cases check that `endSession` really does defer to it.
 */
test('a process that merely names claude in its arguments is not a claude process', async () => {
  const world = machine({
    2345: 'vim CLAUDE.md',
    2346: 'vim /Users/dev/notes/claude',
    2347: 'grep claude /var/log/system.log',
    2348: 'claude-code-something --serve',
  })
  const outcome = await endSession([2345, 2346, 2347, 2348], world.options)

  assert.deepEqual(outcome.skipped, [
    { pid: 2345, reason: 'not-claude' },
    { pid: 2346, reason: 'not-claude' },
    { pid: 2347, reason: 'not-claude' },
    { pid: 2348, reason: 'not-claude' },
  ])
  assert.deepEqual(world.calls, [])
  assert.equal(outcome.ended, false)
})

/*
 * A headless `claude --print` is a script, an editor integration or a harness mid-run. It has
 * no terminal anybody is sitting at and often no transcript to resume from, so it is never the
 * session a user asked to end — but it does share the directory the attribution matches on,
 * which makes it precisely the process a wrong guess lands on.
 */
test('a headless claude --print is tooling rather than a session and is never stopped', async () => {
  const world = machine({
    501: '/usr/local/bin/claude --print --output-format stream-json --verbose',
    502: 'claude -p "summarise this diff"',
    503: 'node /usr/local/bin/claude --resume 4f0c2a --print',
  })
  const outcome = await endSession([501, 502, 503], world.options)

  assert.deepEqual(outcome.skipped, [
    { pid: 501, reason: 'non-interactive' },
    { pid: 502, reason: 'non-interactive' },
    { pid: 503, reason: 'non-interactive' },
  ])
  assert.deepEqual(world.calls, [])
  assert.equal(outcome.ended, false)
})

/*
 * The one case where `--print` is not somebody else's business: aivis spawns its drivers with
 * it, so a driven session's pid is known rather than guessed. Ownership buys past that refusal
 * and nothing else — the process still has to read as a live `claude` when the signal is sent,
 * because the pid was recorded when the child started and may have been handed on since.
 */
test('a claude aivis spawned itself may be stopped despite the --print it was launched with', async () => {
  const args = '/usr/local/bin/claude --print --input-format stream-json --resume 4f0c2a'
  const world = machine({ 4242: args })
  const outcome = await endSession([4242], { ...world.options, owned: [4242] })

  assert.deepEqual(outcome.stopped, [4242])
  assert.deepEqual(outcome.skipped, [])
  assert.equal(outcome.ended, true)

  // Without the claim of ownership the identical process is left alone.
  const other = machine({ 4242: args })
  const guessed = await endSession([4242], other.options)
  assert.deepEqual(guessed.skipped, [{ pid: 4242, reason: 'non-interactive' }])
  assert.deepEqual(other.calls, [])
})

/*
 * Ownership is not a way past the checks that keep a recycled pid from being signalled: the
 * operating system may have handed the number to something else since the child exited.
 */
test('a pid aivis owns is still not signalled once something else holds it', async () => {
  const world = machine({ 4242: 'vim CLAUDE.md' })
  const outcome = await endSession([4242], { ...world.options, owned: [4242] })

  assert.deepEqual(outcome.skipped, [{ pid: 4242, reason: 'not-claude' }])
  assert.deepEqual(world.calls, [])
})

test('a session that leaves on SIGTERM is never killed', async () => {
  const world = machine({ 4242: A_SESSION })
  const outcome = await endSession([4242], world.options)

  assert.deepEqual(outcome.stopped, [4242])
  assert.deepEqual(outcome.forced, [])
  assert.deepEqual(outcome.skipped, [])
  assert.equal(outcome.ended, true)
  assert.deepEqual(signalsTo(world, 4242), [{ pid: 4242, signal: 'SIGTERM', waited: 0 }])
  // One look, and the waiting stopped as soon as the process had gone.
  assert.deepEqual(world.waits, [150])
})

/*
 * SIGKILL costs the session whatever it was in the middle of, so it may only follow a full
 * grace window in which the process was watched and did not leave. The `waited` figure on each
 * signal is the wall time the code under test had asked for by the moment it sent that signal,
 * which is what makes the ordering testable without waiting three seconds for it.
 */
test('a session that ignores SIGTERM is killed only after the whole grace window has passed', async () => {
  const world = machine({ 4242: A_SESSION }, { stubborn: [4242] })
  const outcome = await endSession([4242], world.options)

  assert.deepEqual(signalsTo(world, 4242), [
    { pid: 4242, signal: 'SIGTERM', waited: 0 },
    { pid: 4242, signal: 'SIGKILL', waited: 3000 },
  ])
  assert.deepEqual(outcome.forced, [4242])
  assert.deepEqual(outcome.stopped, [])
  assert.equal(outcome.ended, true)
  assert.equal(world.waits.length, 20)
})

test('the grace window and the interval it is watched over are both settable', async () => {
  const world = machine({ 4242: A_SESSION }, { stubborn: [4242] })
  await endSession([4242], { ...world.options, graceMs: 300, pollMs: 100 })

  assert.deepEqual(world.waits, [100, 100, 100])
  assert.deepEqual(signalsTo(world, 4242), [
    { pid: 4242, signal: 'SIGTERM', waited: 0 },
    { pid: 4242, signal: 'SIGKILL', waited: 300 },
  ])
})

/*
 * A poll interval of zero would leave the escalation window looping without advancing, which
 * would hold the end-session request open for good rather than killing anything.
 */
test('an interval of zero cannot turn the grace window into a loop that never ends', async () => {
  const world = machine({ 4242: A_SESSION }, { stubborn: [4242] })
  await endSession([4242], { ...world.options, graceMs: 5, pollMs: 0 })

  assert.deepEqual(world.waits, [1, 1, 1, 1, 1])
  assert.deepEqual(signalsTo(world, 4242).at(-1), { pid: 4242, signal: 'SIGKILL', waited: 5 })
})

test('a pid that vanished between the scan and the signal is reported rather than signalled', async () => {
  const world = machine({})
  const outcome = await endSession([4242], world.options)

  assert.deepEqual(outcome.skipped, [{ pid: 4242, reason: 'already-gone' }])
  assert.deepEqual(world.calls, [])
  assert.equal(outcome.ended, false)
})

/*
 * The gap between reading a process and signalling it is small but real, and a process that
 * leaves inside it must not be counted as one this request ended.
 */
test('a process the operating system refuses to signal is reported, not counted as ended', async () => {
  const world = machine({ 4242: A_SESSION }, { refuses: [4242] })
  const outcome = await endSession([4242], world.options)

  assert.deepEqual(outcome.skipped, [{ pid: 4242, reason: 'signal-failed' }])
  assert.equal(outcome.ended, false)
  assert.deepEqual(outcome.stopped, [])
})

test('the same pid listed twice is acted on once and reported the second time', async () => {
  const world = machine({ 4242: A_SESSION })
  const outcome = await endSession([4242, 4242], world.options)

  assert.deepEqual(outcome.stopped, [4242])
  assert.deepEqual(outcome.skipped, [{ pid: 4242, reason: 'repeated' }])
  assert.deepEqual(signalsTo(world, 4242), [{ pid: 4242, signal: 'SIGTERM', waited: 0 }])
})

/*
 * An install whose launcher is a `#!/usr/bin/env node` script appears in `ps` behind its
 * runtime, and a session is still a session for it.
 */
test('a claude started through a node launcher is stopped like any other session', async () => {
  const world = machine({ 4242: A_SESSION_UNDER_NODE })
  const outcome = await endSession([4242], world.options)

  assert.deepEqual(outcome.stopped, [4242])
  assert.equal(outcome.ended, true)
})

/*
 * A request that ends nothing has to come back saying so. Every refusal above carries its
 * reason out with it, so the caller can tell "there was nothing left to stop" from "aivis
 * would not stop that".
 */
test('a request in which every pid was refused reports itself as having ended nothing', async () => {
  const world = machine({ 501: 'vim CLAUDE.md', 502: 'claude -p "go"' }, { parents: { [process.pid]: 77 } })
  const outcome = await endSession([0, process.pid, 77, 501, 502, 4242], world.options)

  assert.equal(outcome.ended, false)
  assert.deepEqual(outcome.stopped, [])
  assert.deepEqual(outcome.forced, [])
  assert.deepEqual(
    outcome.skipped.map((entry) => entry.reason),
    ['implausible-pid', 'aivis-itself', 'aivis-ancestor', 'not-claude', 'non-interactive', 'already-gone'],
  )
  assert.deepEqual(world.calls, [])
})

/*
 * `--print` is not the only way to run Claude Code with nobody sitting at it. `claude mcp serve`
 * is started by editors from a `.mcp.json` entry, runs for as long as the editor does, and is
 * given the project root as its working directory — a long-lived `claude` sitting in a
 * directory full of transcripts, carrying nothing that marks it as tooling. That is exactly the
 * shape the attribution behind these pids matches on, so a scan offers it up as a session and
 * ending one would take the editor's tooling down with it.
 */
test('a claude running a tool rather than a conversation is left alone', async () => {
  const world = machine({
    601: 'claude mcp serve',
    602: '/usr/local/bin/claude gateway',
    603: 'node /usr/local/bin/claude --debug mcp serve',
    604: 'claude doctor',
    605: 'claude update',
  })
  const outcome = await endSession([601, 602, 603, 604, 605], world.options)

  assert.deepEqual(
    outcome.skipped.map((entry) => entry.reason),
    ['non-interactive', 'non-interactive', 'non-interactive', 'non-interactive', 'non-interactive'],
  )
  assert.deepEqual(world.calls, [])
  assert.equal(outcome.ended, false)
})

/*
 * The cost of reading the first word that way, stated as a test rather than left to be
 * discovered: a session opened with a prompt that happens to start with one of those words is
 * refused too. `ps` reports no quoting, so `claude "update the changelog"` is indistinguishable
 * from a subcommand — and the user can still type `/exit` in the terminal they are sitting at,
 * which is not true of the process a wrong guess would have killed instead.
 */
test('a session whose opening prompt begins with a tool name is refused as well', async () => {
  const world = machine({ 4242: 'claude update the changelog' })
  const outcome = await endSession([4242], world.options)

  assert.deepEqual(outcome.skipped, [{ pid: 4242, reason: 'non-interactive' }])
  assert.deepEqual(world.calls, [])
})

test('an ordinary session is not mistaken for tooling by the flags it carries', async () => {
  const world = machine({ 4242: 'claude --resume 4f0c2a', 4243: 'claude --ide --model opus' })
  const outcome = await endSession([4242, 4243], world.options)

  assert.deepEqual(outcome.stopped, [4242, 4243])
  assert.deepEqual(outcome.skipped, [])
})

/*
 * `DriverRegistry` forgets a driver the moment its status turns to exited or error, and a start
 * that timed out never registered one at all, so aivis can be running a `claude --print` child
 * that nothing in memory points at. Before this, such a child was refused as tooling forever
 * and no request could reach it. Its parent link settles it without any bookkeeping: a process
 * whose parent is this server is a process this server started.
 */
test('a headless claude aivis is the parent of may be stopped even when nothing named it', async () => {
  const args = '/usr/local/bin/claude --print --input-format stream-json --resume 4f0c2a'
  const world = machine({ 4242: args }, { parents: { 4242: process.pid } })
  const outcome = await endSession([4242], world.options)

  assert.deepEqual(outcome.stopped, [4242])
  assert.equal(outcome.ended, true)

  // The identical process belonging to somebody else is still refused.
  const other = machine({ 4242: args }, { parents: { 4242: 999 } })
  const theirs = await endSession([4242], other.options)
  assert.deepEqual(theirs.skipped, [{ pid: 4242, reason: 'non-interactive' }])
  assert.deepEqual(other.calls, [])
})

/*
 * SIGKILL is the one signal that takes a process out with no chance to save anything, and three
 * seconds separate it from the reading that justified it. A session that exits inside that
 * window frees its number, and the operating system hands numbers out again — pid space is
 * small enough on macOS, and a build churning short-lived processes small enough anywhere, for
 * the number to be somebody else's by the time the window closes.
 */
test('a pid that has become another program by the end of the grace window is not killed', async () => {
  const world = machine({ 4242: A_SESSION }, { stubborn: [4242], becomes: { 4242: 'vim CLAUDE.md' } })
  const outcome = await endSession([4242], world.options)

  assert.deepEqual(outcome.skipped, [{ pid: 4242, reason: 'not-claude' }])
  assert.deepEqual(outcome.forced, [])
  assert.deepEqual(signalsTo(world, 4242), [{ pid: 4242, signal: 'SIGTERM', waited: 0 }])
})

test('a pid that has become somebody else’s tooling by the end of the window is not killed', async () => {
  const world = machine({ 4242: A_SESSION }, { stubborn: [4242], becomes: { 4242: 'claude mcp serve' } })
  const outcome = await endSession([4242], world.options)

  assert.deepEqual(outcome.skipped, [{ pid: 4242, reason: 'non-interactive' }])
  assert.deepEqual(signalsTo(world, 4242), [{ pid: 4242, signal: 'SIGTERM', waited: 0 }])
})

/*
 * The other side of that reading: a session that finally goes just after the window closed did
 * stop, and on SIGTERM, so it counts as stopped rather than as something aivis gave up on.
 */
test('a session ps can no longer describe by the end of the window counts as stopped', async () => {
  const world = machine({ 4242: A_SESSION }, { stubborn: [4242], becomes: { 4242: '' } })
  const outcome = await endSession([4242], world.options)

  assert.deepEqual(outcome.stopped, [4242])
  assert.deepEqual(outcome.forced, [])
  assert.deepEqual(outcome.skipped, [])
  assert.deepEqual(signalsTo(world, 4242), [{ pid: 4242, signal: 'SIGTERM', waited: 0 }])
})
