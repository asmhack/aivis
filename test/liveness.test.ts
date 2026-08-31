import { test } from 'node:test'
import assert from 'node:assert/strict'
import { forgetStalls, type CommandOutput, type CommandRunner } from '../server/bounded.ts'
import {
  forgetLiveProcesses,
  isClaudeProcess,
  liveProcesses,
  parseLsof,
  parsePs,
} from '../server/liveness.ts'

/*
 * These two parsers decide which process id belongs to which session, and everything the
 * server does to a session afterwards trusts that answer: the message routes write to the pid,
 * the attention badge reads from it, and the end-session route signals it. Nothing downstream
 * can tell that an attribution is wrong, so the fixtures below pin the classification rather
 * than the code that produced it — real `ps` and `lsof` output is captured as text and fed in
 * directly, which is also the only way to exercise both platforms' column padding from one
 * machine.
 */

/*
 * One scan holding every shape worth arguing about. The first, second and last processes are
 * genuine `claude` sessions; the middle four merely contain the word, which is what a developer
 * machine looks like when someone is editing the tool's own files.
 */
const PS_SCAN = [
  '  501    01:02:03 /opt/homebrew/bin/claude --resume 4f0c2a',
  ' 1234 09-04:03:55 node /Users/dev/.local/bin/claude --ide',
  ' 2345       05:23 vim CLAUDE.md',
  ' 2346       00:14 vim /Users/dev/notes/claude',
  ' 2347       00:02 grep claude /var/log/system.log',
  ' 2348    03:11:00 claude-code-something --serve',
  ' 2349       00:09 /usr/bin/claude',
  '',
].join('\n')

test('a ps scan yields exactly the processes that are the claude binary itself', () => {
  assert.deepEqual(
    parsePs(PS_SCAN).map((c) => c.pid),
    [501, 1234, 2349],
  )
})

test('each candidate keeps the pid, the elapsed column and the full command line ps reported', () => {
  const [first, second] = parsePs(PS_SCAN)
  assert.deepEqual(first, {
    pid: 501,
    elapsed: '01:02:03',
    args: '/opt/homebrew/bin/claude --resume 4f0c2a',
  })
  // A session running for days reports its elapsed time in a different shape, which is carried
  // through as written rather than interpreted.
  assert.deepEqual(second, {
    pid: 1234,
    elapsed: '09-04:03:55',
    args: 'node /Users/dev/.local/bin/claude --ide',
  })
})

/*
 * The pid column is padded to the widest pid on the machine and the elapsed column to the
 * oldest process, so the same scan looks different on a laptop and on a build box, and Linux
 * pads it differently again. Splitting on runs of whitespace has to survive all of that.
 */
test('padding differences between machines and platforms do not change what is parsed', () => {
  const tight = '7 05:23 claude\n'
  const wide = '  99999      1-00:00:01 /usr/local/bin/claude --print\n'
  assert.deepEqual(parsePs(tight), [{ pid: 7, elapsed: '05:23', args: 'claude' }])
  assert.deepEqual(parsePs(wide), [
    { pid: 99999, elapsed: '1-00:00:01', args: '/usr/local/bin/claude --print' },
  ])
})

test('output with no process lines in it produces no candidates at all', () => {
  assert.deepEqual(parsePs(''), [])
  assert.deepEqual(parsePs('\n\n   \n'), [])
  // `ps -eo pid=` suppresses the header, but a caller that loses the trailing `=` gets one.
  assert.deepEqual(parsePs('  PID     ELAPSED COMMAND\n'), [])
})

/*
 * The predicate below is the one guard between the end-session route and a process the user
 * never meant to stop, so it reads only the executable. Every case here is drawn from a real
 * process table: editors and greps name the tool's files constantly, and an install whose
 * launcher carries a `#!/usr/bin/env node` line reports the runtime as the executable instead.
 */
test('a claude process is recognised however it was launched', () => {
  assert.equal(isClaudeProcess('claude'), true)
  assert.equal(isClaudeProcess('claude --resume 4f0c2a'), true)
  assert.equal(isClaudeProcess('/opt/homebrew/bin/claude --ide'), true)
  assert.equal(isClaudeProcess('node /Users/dev/.local/bin/claude --print'), true)
  assert.equal(isClaudeProcess('node --enable-source-maps /usr/local/bin/claude'), true)
  assert.equal(isClaudeProcess('bun /usr/local/bin/claude'), true)
})

test('a file merely named claude does not turn the program that opened it into a session', () => {
  // Case alone would exclude CLAUDE.md, so the path form is the one that matters: before this
  // was tightened, `vim /Users/dev/notes/claude` read as a live claude process.
  assert.equal(isClaudeProcess('vim CLAUDE.md'), false)
  assert.equal(isClaudeProcess('vim /Users/dev/notes/claude'), false)
  assert.equal(isClaudeProcess('less /usr/local/bin/claude'), false)
  assert.equal(isClaudeProcess('grep claude /var/log/system.log'), false)
  assert.equal(isClaudeProcess('tail -f /Users/dev/claude/log.txt'), false)
})

test('a program whose name only begins or ends with claude is a different program', () => {
  assert.equal(isClaudeProcess('claude-code-something --serve'), false)
  assert.equal(isClaudeProcess('/usr/local/bin/claude-monitor'), false)
  assert.equal(isClaudeProcess('/usr/local/bin/notclaude'), false)
  assert.equal(isClaudeProcess('/Users/dev/claude/scripts/run.sh'), false)
  assert.equal(isClaudeProcess('claude.js'), false)
})

test('an empty or blank command line is nobody, which is what ps reports for a reaped process', () => {
  assert.equal(isClaudeProcess(''), false)
  assert.equal(isClaudeProcess('   '), false)
  assert.equal(isClaudeProcess('node'), false)
  assert.equal(isClaudeProcess('node --version'), false)
})

/*
 * `lsof -Fpn` writes one field per line with a type character in front: `p` opens a process
 * block, `n` gives the path. Nothing in the format marks the end of a block, so the parser
 * carries the current pid forward, and the tests below are about what happens when a block is
 * not the shape that assumption expects.
 */
test('an lsof dump maps every process block to the directory that process works in', () => {
  const dump = ['p501', 'n/Users/dev/work/aivis', 'p1234', 'n/Users/dev/work/other', ''].join('\n')
  assert.deepEqual(
    [...parseLsof(dump)],
    [
      [501, '/Users/dev/work/aivis'],
      [1234, '/Users/dev/work/other'],
    ],
  )
})

test('a block whose path never arrives is dropped rather than given the next block’s directory', () => {
  // The process exited between the ps scan and the lsof call, so lsof named it and said no more.
  const dump = ['p501', 'n/Users/dev/work/aivis', 'p1234', 'p2345', 'n/Users/dev/work/other'].join('\n')
  const cwds = parseLsof(dump)
  assert.equal(cwds.has(1234), false)
  assert.deepEqual(cwds.get(501), '/Users/dev/work/aivis')
  assert.deepEqual(cwds.get(2345), '/Users/dev/work/other')
})

test('a path that arrives before any process block belongs to no one', () => {
  assert.deepEqual([...parseLsof('n/Users/dev/work/aivis\n')], [])
  // A `p` line that is not a number must not leave the previous pid in place to collect the
  // path underneath it, which would hand one session another session's directory.
  const damaged = ['p501', 'n/Users/dev/work/aivis', 'p', 'n/Users/dev/somewhere/else'].join('\n')
  assert.deepEqual([...parseLsof(damaged)], [[501, '/Users/dev/work/aivis']])
})

test('empty lsof output maps nothing, which is what a fleet with no live sessions looks like', () => {
  assert.equal(parseLsof('').size, 0)
  assert.equal(parseLsof('\n').size, 0)
})

/*
 * Above the parsers sits the layer that decides whether the fleet reports any live process at
 * all, and it answers with an empty list for three different reasons: nothing is running, the
 * scan failed, or the scan was skipped because the last one had to be abandoned. Everything
 * downstream — the end-session route, the message routes, the attention badge — reads that
 * list as fact, so what follows drives each of those reasons through an injected runner and
 * pins which of them are allowed to empty the fleet.
 */

/** Canned answers for the two commands, standing in for the processes on a machine. */
function answering(replies: Record<string, CommandOutput>): { asked: string[]; run: CommandRunner } {
  const asked: string[] = []
  const run: CommandRunner = (command) => {
    asked.push(command)
    return {
      done: Promise.resolve(replies[command] ?? { stdout: '', failed: true }),
      release: () => {},
    }
  }
  return { asked, run }
}

const ok = (stdout: string): CommandOutput => ({ stdout, failed: false })
const broke = (stdout = ''): CommandOutput => ({ stdout, failed: true })

const TWO_SESSIONS = ' 501 01:02:03 claude --resume 4f0c2a\n 502 00:11:00 claude --ide\n'
const BOTH_DIRECTORIES = ['p501', 'n/Users/dev/work/aivis', 'p502', 'n/Users/dev/work/other', ''].join('\n')

test('a scan that worked reports every claude process with the directory it works in', async (t) => {
  forgetLiveProcesses()
  forgetStalls()
  t.after(forgetLiveProcesses)
  const { run } = answering({ ps: ok(TWO_SESSIONS), lsof: ok(BOTH_DIRECTORIES) })

  assert.deepEqual(await liveProcesses(0, { run, log: () => {} }), [
    { pid: 501, cwd: '/Users/dev/work/aivis', args: 'claude --resume 4f0c2a', elapsed: '01:02:03' },
    { pid: 502, cwd: '/Users/dev/work/other', args: 'claude --ide', elapsed: '00:11:00' },
  ])
})

/*
 * A process scan that failed is not evidence that the machine is quiet, but it is all there is:
 * the pids feed routes that signal and write to processes, so serving a list that could not be
 * confirmed is worse than serving none. What must not happen is that the empty answer is then
 * cached as though it were a reading, which would hold the fleet quiet for a full cache window
 * after the trouble had passed.
 */
test('a failed process scan empties the fleet, says so once, and is not remembered as a reading', async (t) => {
  forgetLiveProcesses()
  forgetStalls()
  t.after(forgetLiveProcesses)
  const logged: string[] = []
  const log = (message: string): void => void logged.push(message)
  const now = (): number => 1_000_000
  const failing = answering({ ps: broke() })

  assert.deepEqual(await liveProcesses(4000, { run: failing.run, now, log }), [])
  assert.deepEqual(await liveProcesses(4000, { run: failing.run, now, log }), [])
  assert.equal(logged.length, 1, 'the outage is reported once, not on every tick')
  assert.match(logged[0] ?? '', /process scan failed/)

  // The clock has not moved, so an empty reading would still be cached; the next scan runs
  // anyway and the fleet comes straight back.
  const working = answering({ ps: ok(TWO_SESSIONS), lsof: ok(BOTH_DIRECTORIES) })
  const back = await liveProcesses(4000, { run: working.run, now, log })
  assert.deepEqual(
    back.map((p) => p.pid),
    [501, 502],
  )
})

/*
 * `lsof` is the call that wedges on a broken mount, and it is asked about every claude process
 * on the machine at once. Dropping the processes it did not describe would take every session
 * down with the one directory that broke — including the ones with nothing to do with it — and
 * an empty fleet is not inert: it is what makes a message start a second process against a
 * session that is still running. The pid was in `ps` a moment ago and a session does not move
 * house, so the directory lsof last confirmed for it stands.
 */
test('a directory lookup that could not be read keeps the directory it last reported', async (t) => {
  forgetLiveProcesses()
  forgetStalls()
  t.after(forgetLiveProcesses)
  const logged: string[] = []
  const log = (message: string): void => void logged.push(message)
  const confirmed = answering({ ps: ok(TWO_SESSIONS), lsof: ok(BOTH_DIRECTORIES) })
  await liveProcesses(0, { run: confirmed.run, log })

  const wedged = answering({ ps: ok(TWO_SESSIONS), lsof: broke() })
  assert.deepEqual(await liveProcesses(0, { run: wedged.run, log }), [
    { pid: 501, cwd: '/Users/dev/work/aivis', args: 'claude --resume 4f0c2a', elapsed: '01:02:03' },
    { pid: 502, cwd: '/Users/dev/work/other', args: 'claude --ide', elapsed: '00:11:00' },
  ])
  assert.match(logged.at(-1) ?? '', /lsof could not be read/)
})

/*
 * The carried-over directory is only for the case where lsof could not answer. When it answers
 * and simply does not mention a pid, that pid exited between the two commands, and reporting it
 * as live would point a session at a process that is not there.
 */
test('a process lsof answered about and did not mention has gone, and is dropped', async (t) => {
  forgetLiveProcesses()
  forgetStalls()
  t.after(forgetLiveProcesses)
  const confirmed = answering({ ps: ok(TWO_SESSIONS), lsof: ok(BOTH_DIRECTORIES) })
  await liveProcesses(0, { run: confirmed.run, log: () => {} })

  const half = answering({ ps: ok(TWO_SESSIONS), lsof: ok('p502\nn/Users/dev/work/other\n') })
  assert.deepEqual(
    (await liveProcesses(0, { run: half.run, log: () => {} })).map((p) => p.pid),
    [502],
  )
})

/*
 * What is carried over is only ever a reading lsof itself gave, and only for a process that is
 * still in the table. A pid that leaves the machine takes its directory with it, so the number
 * coming back later — to a different program, as the operating system recycles it — inherits
 * nothing.
 */
test('a process that left the machine does not lend its directory to whatever gets its pid', async (t) => {
  forgetLiveProcesses()
  forgetStalls()
  t.after(forgetLiveProcesses)
  const confirmed = answering({ ps: ok(TWO_SESSIONS), lsof: ok(BOTH_DIRECTORIES) })
  await liveProcesses(0, { run: confirmed.run, log: () => {} })

  // 501 has gone; only 502 is left, and lsof still works.
  const fewer = answering({ ps: ok(' 502 00:11:00 claude --ide\n'), lsof: ok('p502\nn/Users/dev/work/other\n') })
  await liveProcesses(0, { run: fewer.run, log: () => {} })

  // 501 is back as somebody else's claude, and now lsof cannot be read.
  const wedged = answering({ ps: ok(TWO_SESSIONS), lsof: broke() })
  assert.deepEqual(
    (await liveProcesses(0, { run: wedged.run, log: () => {} })).map((p) => p.pid),
    [502],
  )
})

/*
 * A directory whose own name contains a newline reads exactly like the start of another
 * process block, which is how a pid nobody asked about turns up in the output. Filing it would
 * hand the routes a process that was never scanned at all.
 */
test('a directory reported for a pid that was never asked about is thrown away', async (t) => {
  forgetLiveProcesses()
  forgetStalls()
  t.after(forgetLiveProcesses)
  const { run } = answering({
    ps: ok(' 501 01:02:03 claude --resume 4f0c2a\n'),
    lsof: ok(['p501', 'n/Users/dev/work/aivis', 'p999', 'n/Users/dev/elsewhere', ''].join('\n')),
  })

  assert.deepEqual(
    (await liveProcesses(0, { run, log: () => {} })).map((p) => p.pid),
    [501],
  )
})

test('a machine with no claude processes on it is never asked about their directories', async (t) => {
  forgetLiveProcesses()
  forgetStalls()
  t.after(forgetLiveProcesses)
  const quietMachine = answering({ ps: ok(' 2345 05:23 vim CLAUDE.md\n') })

  assert.deepEqual(await liveProcesses(0, { run: quietMachine.run, log: () => {} }), [])
  assert.deepEqual(quietMachine.asked, ['ps'])
})

test('a reading inside the cache window is served without asking anything again', async (t) => {
  forgetLiveProcesses()
  forgetStalls()
  t.after(forgetLiveProcesses)
  const { asked, run } = answering({ ps: ok(TWO_SESSIONS), lsof: ok(BOTH_DIRECTORIES) })
  const now = (): number => 1_000_000

  await liveProcesses(4000, { run, now, log: () => {} })
  await liveProcesses(4000, { run, now, log: () => {} })
  assert.deepEqual(asked, ['ps', 'lsof'])
})
