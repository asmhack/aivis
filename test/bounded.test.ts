import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { forgetStalls, runBounded, withDeadline, type CommandOutput, type CommandRunner } from '../server/bounded.ts'

/*
 * Something referenced, for as long as this file runs.
 *
 * `runBounded` unrefs its abandon timer on purpose, so a command parked in the kernel can
 * never be the reason aivis stays alive. The server always has a listening socket holding the
 * loop open, so the timer fires there regardless. Here the wedged command is the only thing in
 * flight, and an unreferenced timer is not enough to keep the loop from draining: Node decides
 * there is nothing left to do, exits before the abandonment lands, and every test still waiting
 * is reported as cancelled rather than failed. It survived on macOS by luck of timing and
 * failed on Linux, which is where CI runs. One referenced interval stands in for the socket.
 */
const keepLoopAlive = setInterval(() => {}, 1_000)
after(() => clearInterval(keepLoopAlive))

/*
 * Every command the fleet refresh runs goes through here, and the case that matters is the one
 * that cannot be reproduced on a healthy machine: a child parked in the kernel by a stale mount,
 * which no signal reaches and which therefore never answers. What follows drives that case by
 * handing `runBounded` a command that simply never settles, and pins the three things the
 * server depends on — that the caller is released, that the child's pipes are let go, and that
 * a mount which stays broken is not asked again on every tick.
 *
 * Nothing here spawns a process. The runner is injected, and time is injected wherever the
 * answer depends on it, so the cooldown is exercised without waiting out a real one.
 */

/** One command the code under test asked for, and the handle to answer it with. */
interface Attempt {
  command: string
  args: string[]
  answer: (output: CommandOutput) => void
  released: boolean
}

function recorder(): { attempts: Attempt[]; run: CommandRunner } {
  const attempts: Attempt[] = []
  const run: CommandRunner = (command, args) => {
    let answer!: (output: CommandOutput) => void
    const done = new Promise<CommandOutput>((resolve) => {
      answer = resolve
    })
    const attempt: Attempt = { command, args, answer, released: false }
    attempts.push(attempt)
    return {
      done,
      release: () => {
        attempt.released = true
      },
    }
  }
  return { attempts, run }
}

/** A clock the test moves by hand, so a fifteen-second pause costs nothing to observe. */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let at = start
  return {
    now: () => at,
    advance: (ms) => {
      at += ms
    },
  }
}

test('a command that answers is handed back exactly as it answered', async (t) => {
  forgetStalls()
  t.after(forgetStalls)
  const { attempts, run } = recorder()

  const call = runBounded('ps', ['-eo', 'pid='], { run, key: 'answers' })
  attempts[0]?.answer({ stdout: '  501 claude\n', failed: false })

  assert.deepEqual(await call, { stdout: '  501 claude\n', failed: false })
  assert.deepEqual(attempts[0]?.args, ['-eo', 'pid='])
  assert.equal(attempts[0]?.released, false)
})

/*
 * `lsof` exits non-zero whenever any of the pids it was asked about has gone, and still prints
 * every one that has not. Losing that output would empty the fleet every time a session ended
 * between the scan and the lookup.
 */
test('output printed before a command failed is still handed back', async (t) => {
  forgetStalls()
  t.after(forgetStalls)
  const { attempts, run } = recorder()

  const call = runBounded('lsof', [], { run, key: 'partial' })
  attempts[0]?.answer({ stdout: 'p501\nn/Users/dev/work\n', failed: true })

  assert.deepEqual(await call, { stdout: 'p501\nn/Users/dev/work\n', failed: true })
})

/*
 * The failure this module exists for: the command is signalled, the signal does not land
 * because the process is in uninterruptible sleep, and the promise never settles. The caller
 * has to come back anyway, and the parent's side of the child's pipes has to be let go — a
 * stranded child that keeps three descriptors open on every scan is how a daemon that merely
 * looked frozen ends up unable to open a file at all.
 */
test('a command that never answers releases the caller and the child it was waiting on', async (t) => {
  forgetStalls()
  t.after(forgetStalls)
  const { attempts, run } = recorder()
  const logged: string[] = []

  const outcome = await runBounded('lsof', [], {
    run,
    key: 'wedged',
    abandonAfterMs: 5,
    log: (message) => logged.push(message),
  })

  assert.deepEqual(outcome, { stdout: '', failed: true })
  assert.equal(attempts[0]?.released, true)
  assert.equal(logged.length, 1)
  assert.match(logged[0] ?? '', /lsof did not return within 5ms/)
})

/*
 * Whatever wedged the command is still wedged a moment later, so retrying on the next three
 * second tick would strand a new stuck child every time. The pause is what bounds that, and it
 * has to apply without the command being started to find out.
 */
test('a command that had to be abandoned is not started again until the pause is over', async (t) => {
  forgetStalls()
  t.after(forgetStalls)
  const { attempts, run } = recorder()
  const time = clock()
  const options = { run, key: 'cooling', abandonAfterMs: 5, now: time.now, log: (): void => {} }

  await runBounded('lsof', [], options)
  assert.equal(attempts.length, 1)

  time.advance(14_999)
  assert.deepEqual(await runBounded('lsof', [], options), { stdout: '', failed: true })
  assert.equal(attempts.length, 1, 'nothing was spawned while the pause was running')

  time.advance(2)
  const retry = runBounded('lsof', [], options)
  assert.equal(attempts.length, 2)
  attempts[1]?.answer({ stdout: 'p501\n', failed: false })
  assert.deepEqual(await retry, { stdout: 'p501\n', failed: false })
})

/*
 * A flat pause only slows the leak down: a mount that stays broken for an hour would still
 * strand a child every fifteen seconds. Doubling it turns an unbounded stream into a handful,
 * and coming back once undoes the whole escalation, so a mount that recovers is scanned at
 * full speed from the next tick.
 */
test('each consecutive abandonment doubles the pause, and one clean answer ends it', async (t) => {
  forgetStalls()
  t.after(forgetStalls)
  const { attempts, run } = recorder()
  const time = clock()
  const logged: string[] = []
  const options = {
    run,
    key: 'escalating',
    abandonAfterMs: 5,
    now: time.now,
    log: (message: string): void => void logged.push(message),
  }

  await runBounded('lsof', [], options)
  time.advance(15_001)
  await runBounded('lsof', [], options)
  time.advance(30_001)
  await runBounded('lsof', [], options)

  assert.deepEqual(
    logged.map((line) => line.match(/for (\d+)ms/)?.[1]),
    ['15000', '30000', '60000'],
  )

  // The mount comes back: the next attempt answers, and the one after that starts over at the
  // first pause rather than the fourth.
  time.advance(60_001)
  const recovered = runBounded('lsof', [], options)
  attempts.at(-1)?.answer({ stdout: 'p501\n', failed: false })
  await recovered

  await runBounded('lsof', [], options)
  assert.match(logged.at(-1) ?? '', /for 15000ms/)
})

/*
 * The pause is remembered against a key rather than globally, because `lsof` wedging says
 * nothing about `ps`, and one repository on a broken mount says nothing about the others.
 */
test('one wedged command does not silence a different one', async (t) => {
  forgetStalls()
  t.after(forgetStalls)
  const { attempts, run } = recorder()
  const time = clock()

  await runBounded('lsof', [], { run, key: 'lsof', abandonAfterMs: 5, now: time.now, log: () => {} })
  const other = runBounded('ps', [], { run, key: 'ps', abandonAfterMs: 5, now: time.now, log: () => {} })
  assert.equal(attempts.length, 2)
  attempts[1]?.answer({ stdout: '501 claude\n', failed: false })
  assert.equal((await other).failed, false)
})

/*
 * Not everything that can hang is a subprocess. `fs.readFile` on a wedged mount cannot be
 * signalled at all, so the only thing available is to stop waiting for it.
 */
test('work that outstays its deadline gives the caller the answer it was told to assume', async () => {
  const settled = await withDeadline(Promise.resolve('{"model":"opus"}'), 50, null)
  assert.equal(settled, '{"model":"opus"}')

  const never = new Promise<string>(() => {})
  assert.equal(await withDeadline(never, 5, null), null)
})

test('work that fails after nobody is waiting for it does not take the server down', async () => {
  const late = new Promise<string>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the mount finally answered, badly')), 10)
    timer.unref()
  })
  assert.equal(await withDeadline(late, 1, null), null)
  // The rejection lands here, with nothing awaiting it; an unhandled one would end the process.
  await new Promise((resolve) => setTimeout(resolve, 30))
})
