import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SessionDriver } from '../server/driver.ts'

/**
 * The two pieces of the stdout parse path that have no public mirror.
 *
 * Everything a driver reports to the page — its state, its detail, how much is queued — is
 * already on `status`, and the tests below read it there. These two are the exception: the
 * whole point of the cap is that an oversized line stops being held in memory, and memory
 * that has been released is invisible from outside. So `parts` and `held` are checked
 * directly, and `consume` and `finish` are the two entry points a chunk of stdout and a
 * child's exit arrive through.
 */
interface Internals {
  parts: string[]
  held: number
  consume(chunk: string): void
  finish(state: string, detail: string): void
}

/**
 * A driver whose child is a fake, built without running the constructor.
 *
 * `new SessionDriver(...)` spawns a real `claude` process and wires itself to that
 * process's pipes, which no test may do — so the instance is made from the prototype and
 * seeded with the state a just-started driver holds. That seeding is a knowing coupling to
 * the class's private fields: it is what a child injected through the constructor would
 * remove, and until the driver grows that seam this list has to be kept in step with the
 * fields the constructor sets. The `status` check below is what makes drifting apart fail
 * here, loudly and in one place, rather than somewhere in the middle of an overflow.
 *
 * The fake child records the calls `stop()` makes rather than ending a pipe or signalling a
 * pid, which is what lets a test assert that an overflow stops the session without any real
 * process being involved.
 */
function fakeDriver(): { driver: SessionDriver; inner: Internals; stopped: string[] } {
  const stopped: string[] = []
  const driver = Object.create(SessionDriver.prototype) as SessionDriver
  const inner = driver as unknown as Internals
  Object.assign(driver, {
    sessionId: 'abcdef01-2345',
    cwd: '/tmp',
    parts: [],
    held: 0,
    overflowed: false,
    overflowDetail: null,
    killTimer: null,
    stateValue: 'idle',
    detail: null,
    pending: 0,
    permissionMode: 'default',
    controlSeq: 0,
    interrupts: new Set<string>(),
    stopping: false,
    asks: new Map(),
    announce: () => {},
    onChange: () => {},
    proc: {
      stdin: { writable: true, end: () => stopped.push('end'), write: () => true },
      kill: (signal: string) => stopped.push(signal),
    },
  })
  // An idle session that has said nothing yet, which is what every test below starts from.
  // A driver that reports anything else here was not seeded with everything it reads.
  assert.deepEqual(
    driver.status,
    { sessionId: 'abcdef01-2345', state: 'idle', detail: null, queued: 0, permissionMode: 'default', asks: [] },
    'the fake stands in for a driver that has just started',
  )
  assert.equal(driver.alive, true, 'and one that is still running')
  return { driver, inner, stopped }
}

/** The size a pipe actually hands stdout over in. */
const CHUNK = 'x'.repeat(64 * 1024)
/** One chunk more than the 64 MB cap holds, so the last one is what crosses it. */
const CHUNKS_PAST_CAP = (64 * 1024 * 1024) / CHUNK.length + 1

/**
 * Write a line with no newline in it until it crosses the cap, after an optional prefix.
 *
 * The same 64 KB string is fed over and over rather than one enormous one being built,
 * because the driver holds the pieces it was given and never copies them: a runaway line is
 * reached here for the cost of a single chunk. It is fed a chunk at a time for the same
 * reason a real one arrives that way — the 1024-odd reads a pipe delivers 64 MB in are the
 * ones the cap has to be reached through. Feeding it in a handful of huge chunks instead
 * would hide the cost of getting there: the same 64 MB read one string-concatenation at a
 * time takes seconds of event loop rather than milliseconds.
 */
function overflow(inner: Internals, prefix = ''): void {
  for (let i = 0; i < CHUNKS_PAST_CAP; i++) inner.consume(i === 0 ? prefix + CHUNK : CHUNK)
}

test('an event split across chunks is still parsed whole', () => {
  const { driver, inner } = fakeDriver()
  assert.equal(driver.send('go'), true, 'a turn is queued')
  const line = '{"type":"result","padding":"' + 'a'.repeat(1_000_000) + '"}'
  inner.consume(line.slice(0, 500_000))
  inner.consume(line.slice(500_000) + '\n')
  assert.equal(driver.status.queued, 0, 'the result was acted on')
  assert.equal(inner.held, 0, 'nothing is held once the newline arrives')
  assert.deepEqual(inner.parts, [], 'and the pieces it was read in are released with it')
})

test('a line past the cap is discarded and the session it came from is stopped', () => {
  const { driver, inner, stopped } = fakeDriver()
  overflow(inner)
  assert.equal(inner.held, 0, 'the oversized partial line is not held')
  assert.deepEqual(inner.parts, [], 'in whole or in pieces')
  assert.match(driver.status.detail ?? '', /exceeded 64 MB/, 'and the page is told why')
  assert.deepEqual(stopped, ['end', 'SIGTERM'], 'the child is stopped rather than orphaned')
})

test('an overflowed driver stays alive until its child reports itself gone', () => {
  const { driver, inner } = fakeDriver()
  overflow(inner)
  // Alive is what keeps the driver in the registry, which is where `endSession` reads the
  // one claude pid it may signal: unregistering a driver whose child is still running would
  // leave that child unkillable from the page and its session free to be resumed twice over.
  assert.equal(driver.alive, true, 'the session is not written off before its process is')
  inner.finish('exited', 'exit code 0')
  assert.equal(driver.alive, false, 'the exit is what ends it')
  assert.equal(driver.status.state, 'error', 'and a polite exit does not make this a clean one')
  assert.match(driver.status.detail ?? '', /exceeded 64 MB/, 'the overflow is still the reason')
})

test('a child that ignores the overflow SIGTERM is killed outright', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { inner, stopped } = fakeDriver()
  overflow(inner)
  assert.deepEqual(stopped, ['end', 'SIGTERM'], 'politely first')
  t.mock.timers.tick(5000)
  assert.deepEqual(stopped, ['end', 'SIGTERM', 'SIGKILL'], 'then not')
})

test('the escalation is dropped once the child is gone', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { inner, stopped } = fakeDriver()
  overflow(inner)
  inner.finish('error', 'signal SIGTERM')
  t.mock.timers.tick(5000)
  assert.deepEqual(stopped, ['end', 'SIGTERM'], 'nothing is signalled at a pid that is free')
})

test('the tail of a discarded line is never parsed as an event of its own', () => {
  const { driver, inner, stopped } = fakeDriver()
  driver.send('one')
  driver.send('two')
  overflow(inner)
  // What a child would pad an oversized line with to have a forged event read out of its
  // tail once the buffer was released.
  inner.consume('{"type":"result","is_error":false}\n{"type":"system","subtype":"init"}\n')
  assert.equal(driver.status.queued, 2, 'no event is read out of the remains of the one dropped')
  assert.equal(inner.held, 0, 'and nothing is buffered on either')
  assert.match(driver.status.detail ?? '', /exceeded 64 MB/, 'the reason is not overwritten')
  assert.deepEqual(stopped, ['end', 'SIGTERM'], 'the stop is not repeated per chunk')
})

test('complete events that arrived alongside a runaway line are still acted on', () => {
  const { driver, inner } = fakeDriver()
  driver.send('go')
  // The runaway line begins in the same chunk that carried a whole event and then runs on
  // for chunks on end, which is what one looks like on a pipe: the cap is measured over
  // everything held since the last newline, not over the chunk that happens to cross it.
  overflow(inner, '{"type":"result"}\n')
  assert.equal(driver.status.queued, 0, 'the whole line before the runaway one was handled')
  assert.match(driver.status.detail ?? '', /exceeded 64 MB/, 'and the runaway one still stopped it')
})

test('the overflow is the reason reported, not the exit its own kill brings on', () => {
  const { driver, inner } = fakeDriver()
  overflow(inner)
  const detail = driver.status.detail
  inner.finish('error', 'signal SIGTERM')
  assert.equal(driver.status.detail, detail, 'the signal aivis sent is not the story')
})

test('reaching the cap costs one pass over the line, not one per chunk', () => {
  const { inner } = fakeDriver()
  const started = Date.now()
  overflow(inner)
  // A shape check rather than a benchmark: scanning only each arriving chunk is linear and
  // takes milliseconds, while re-splitting the accumulation on every chunk copies 64 MB a
  // thousand times over and measured 5.2 s on the machine this was written on. Anything in
  // between still leaves the daemon — and every other driven session on its event loop —
  // unresponsive for as long as it takes, so the bound is generous but not unbounded.
  assert.ok(Date.now() - started < 2000, 'the 64 MB cap is reached without stalling the loop')
})

/**
 * What the queue count means, and what the state is read off.
 *
 * Claude Code does not answer one message per turn. A message that arrives while a turn is
 * running is absorbed into that turn — the transcript records the removal as
 * `absorbed_mid_turn` — and the turn reports a single `result` for everything it took in.
 * A driver that subtracted one per result therefore drifted upward for good: three messages
 * and one result left two permanently queued, and since the state was read off that count,
 * the page reported a session as working hours after it had answered and gone quiet.
 *
 * So the count clears at the turn boundary, and the state gets a second source: output from
 * a turn means a turn is running, which is the only sign of a message that was queued rather
 * than absorbed and starts its own turn after the result of the one before it.
 */

test('messages absorbed into a turn already running leave nothing queued behind them', () => {
  const { driver, inner } = fakeDriver()
  driver.send('the first thing')
  // Two more sent while that turn runs. Claude Code folds both into it rather than
  // starting turns of their own, so all three are answered by one result.
  driver.send('and another thought')
  driver.send('and one more')
  assert.equal(driver.status.queued, 3, 'all three are in flight while the turn runs')
  assert.equal(driver.status.state, 'working')

  inner.consume('{"type":"result","is_error":false}\n')

  assert.equal(driver.status.queued, 0, 'the turn answered every one of them')
  assert.equal(driver.status.state, 'idle', 'so the session reads as idle rather than busy')
})

test('a turn that starts on its own after a result puts the driver back to working', () => {
  const { driver, inner } = fakeDriver()
  driver.send('go')
  inner.consume('{"type":"result","is_error":false}\n')
  assert.equal(driver.status.state, 'idle')

  // A message queued rather than absorbed runs once the turn before it reports, and no
  // send marks the moment: the output it produces is the only sign there is.
  inner.consume('{"type":"assistant","message":{"role":"assistant"}}\n')
  assert.equal(driver.status.state, 'working', 'output means a turn is running')
  assert.equal(driver.status.queued, 0, 'and says nothing about what is queued behind it')

  inner.consume('{"type":"result","is_error":false}\n')
  assert.equal(driver.status.state, 'idle', 'and its own result ends it')
})

test('the count the session itself reported through an interrupt outlives the turn it cut short', () => {
  const { driver, inner } = fakeDriver()
  driver.send('go')
  assert.equal(driver.interrupt(), true)
  // The session answers an interrupt with what survived it, which is better than any count
  // kept here: those messages have not run yet and still have their turns coming.
  inner.consume(
    '{"type":"control_response","response":{"subtype":"success","request_id":"aivis-interrupt-1",' +
      '"response":{"still_queued":[{"one":1},{"two":2}]}}}\n',
  )
  assert.equal(driver.status.queued, 2)

  inner.consume('{"type":"result","is_error":true}\n')

  assert.equal(driver.status.queued, 2, 'the interrupted turn does not clear what it never took in')
  assert.equal(driver.status.state, 'working', 'because two turns are still to come')
  assert.equal(driver.status.detail, 'stopped', 'and the error it ended on was the interrupt')
})

test('output that arrives after the child is gone does not bring the driver back to life', () => {
  const { driver, inner } = fakeDriver()
  inner.finish('exited', 'exit code 0')
  inner.consume('{"type":"assistant","message":{"role":"assistant"}}\n')
  assert.equal(driver.status.state, 'exited', 'a session that has ended stays ended')
})
