import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Block } from '../shared/types.ts'

/**
 * `server/blocks.ts` keeps its accumulated hours, its live rate-limit capture and both of
 * its environment settings in module-level state, all of it read or built once at import.
 * There is no exported reset and no factory, so tests cannot share one instance without
 * leaking into each other. What they can do is import the module again under a distinct
 * query string, which makes Node treat it as a different specifier and evaluate it afresh:
 * a new empty `hours` map, a new `live`, and a new reading of the environment. Every test
 * below therefore starts from a genuinely clean module rather than an assumed one.
 *
 * The environment is also restored immediately after each import, so the settings a test
 * asks for only ever reach the instance it asked them for.
 */
type BlocksModule = typeof import('../server/blocks.ts')

/**
 * A home directory with no `~/.claude/aivis-rate-limits.json` in it.
 *
 * `blocks.ts` resolves that path from `os.homedir()` at import time, and `os.homedir()`
 * honours `HOME`. Pointing it at an empty directory keeps the developer's own captured
 * rate-limit file — which does exist on a machine that runs aivis — out of the assertions.
 */
const EMPTY_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'aivis-blocks-empty-home-'))

let imports = 0

async function freshBlocks(env: Record<string, string | undefined> = {}): Promise<BlocksModule> {
  const wanted: Record<string, string | undefined> = {
    HOME: EMPTY_HOME,
    AIVIS_BLOCK_HOURS: undefined,
    AIVIS_BLOCK_TOKEN_LIMIT: undefined,
    ...env,
  }
  const saved: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(wanted)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    imports += 1
    const specifier = `../server/blocks.ts?fresh=${imports}`
    return (await import(specifier)) as BlocksModule
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/**
 * Run something with the wall clock pinned, so "now" is an input rather than a race.
 *
 * The module reads the clock through `Date.now()` in `buildBlocks` and `toBlock`, which is
 * what decides which block is active and how much of it is left.
 */
async function asIfNow<T>(now: number, run: () => Promise<T>): Promise<T> {
  const real = Date.now
  Date.now = () => now
  try {
    return await run()
  } finally {
    Date.now = real
  }
}

function nth(blocks: readonly Block[], index: number): Block {
  const block = blocks[index]
  assert.ok(block, `expected a block at index ${index}, got ${blocks.length} blocks`)
  return block
}

const HOUR = 3600_000
const BLOCK = 5 * HOUR
/** A fixed, long-past anchor that sits exactly on an hour, so bucketing maths is readable. */
const BASE = Date.UTC(2001, 0, 1, 0, 0, 0)
const iso = (ms: number): string => new Date(ms).toISOString()

test('with nothing recorded there is no block to draw and the ceiling is zero rather than an undefined scale', async () => {
  const blocks = await freshBlocks()
  const usage = await blocks.blockUsage()

  assert.deepEqual(usage.recent, [])
  assert.equal(usage.current, null)
  assert.equal(usage.todayTokens, 0)
  // The default configuration has no AIVIS_BLOCK_TOKEN_LIMIT, so the ceiling is derived,
  // and with no history to derive it from it is zero. Zero is meaningful here: it is the
  // value BlockMeter tests with `if (!ceiling)` before it would ever divide by it.
  assert.equal(usage.ceilingTokens, 0)
  assert.equal(usage.ceilingIsObserved, true)
  assert.equal(usage.blockHours, 5)
})

test('every turn recorded inside one block is summed into that block, whatever minute of whatever hour it landed on', async () => {
  const blocks = await freshBlocks()
  blocks.recordUsage(iso(BASE + 5 * 60_000), 100)
  blocks.recordUsage(iso(BASE + 65 * 60_000), 250)
  blocks.recordUsage(iso(BASE + 4 * HOUR + 59 * 60_000), 7)

  const usage = await asIfNow(BASE + 30 * BLOCK, () => blocks.blockUsage())

  assert.equal(usage.recent.length, 1)
  const only = nth(usage.recent, 0)
  assert.equal(only.startedAt, iso(BASE))
  assert.equal(only.endsAt, iso(BASE + BLOCK))
  assert.equal(only.tokens, 357)
})

test('an hour exactly one block-length after the start opens the next block instead of joining it, so the window is half-open', async () => {
  const blocks = await freshBlocks()
  blocks.recordUsage(iso(BASE), 100)
  // The last instant before the block closes still belongs to it: its hour is 04:00.
  blocks.recordUsage(iso(BASE + BLOCK - 1), 10)
  // The instant the block closes belongs to the next one, because the grouping test is
  // `hour >= start + BLOCK_MS` and not `>`.
  blocks.recordUsage(iso(BASE + BLOCK), 1000)

  const usage = await asIfNow(BASE + 30 * BLOCK, () => blocks.blockUsage())

  assert.equal(usage.recent.length, 2)
  assert.equal(nth(usage.recent, 0).startedAt, iso(BASE))
  assert.equal(nth(usage.recent, 0).endsAt, iso(BASE + BLOCK))
  assert.equal(nth(usage.recent, 0).tokens, 110)
  assert.equal(nth(usage.recent, 1).startedAt, iso(BASE + BLOCK))
  assert.equal(nth(usage.recent, 1).tokens, 1000)
})

test('a timestamp on an hour boundary belongs to the hour it opens, so the block it anchors starts there and not an hour earlier', async () => {
  const onTheHour = await freshBlocks()
  onTheHour.recordUsage(iso(BASE + 5 * HOUR), 42)
  const opened = await asIfNow(BASE + 30 * BLOCK, () => onTheHour.blockUsage())
  assert.equal(nth(opened.recent, 0).startedAt, iso(BASE + 5 * HOUR))

  const oneMillisecondEarlier = await freshBlocks()
  oneMillisecondEarlier.recordUsage(iso(BASE + 5 * HOUR - 1), 42)
  const before = await asIfNow(BASE + 30 * BLOCK, () => oneMillisecondEarlier.blockUsage())
  assert.equal(nth(before.recent, 0).startedAt, iso(BASE + 4 * HOUR))
})

test('usage that arrives out of chronological order lands in exactly the blocks it would have in order, because transcripts are scanned in whatever order the directory yields', async () => {
  const samples: Array<[number, number]> = [
    [BASE + 10 * 60_000, 100],
    [BASE + 3 * HOUR, 20],
    [BASE + BLOCK + 1 * HOUR, 700],
    [BASE + BLOCK + 2 * HOUR, 3],
    [BASE + 3 * BLOCK, 5000],
  ]

  const inOrder = await freshBlocks()
  for (const [at, tokens] of samples) inOrder.recordUsage(iso(at), tokens)

  const shuffled = await freshBlocks()
  for (const index of [3, 0, 4, 2, 1]) {
    const sample = samples[index]
    assert.ok(sample)
    shuffled.recordUsage(iso(sample[0]), sample[1])
  }

  const ordered = await asIfNow(BASE + 30 * BLOCK, () => inOrder.blockUsage())
  const jumbled = await asIfNow(BASE + 30 * BLOCK, () => shuffled.blockUsage())

  assert.equal(ordered.recent.length, 3)
  assert.deepEqual(jumbled.recent, ordered.recent)
})

test('the current block is anchored to the hour usage began, so its start and end do not drift as time passes inside it', async () => {
  const blocks = await freshBlocks()
  blocks.recordUsage(iso(BASE + 30 * 60_000), 400)

  const early = await asIfNow(BASE + HOUR, () => blocks.blockUsage())
  const current = early.current
  assert.ok(current)
  assert.equal(current.active, true)
  assert.equal(current.startedAt, iso(BASE))
  assert.equal(current.endsAt, iso(BASE + BLOCK))
  assert.equal(current.remainingMs, BLOCK - HOUR)

  // Ninety minutes later, and with more usage recorded in the meantime, the same block is
  // still open on the same clock. Only the tokens and the countdown move.
  blocks.recordUsage(iso(BASE + 2 * HOUR + 15 * 60_000), 600)
  const later = await asIfNow(BASE + 2 * HOUR + 30 * 60_000, () => blocks.blockUsage())
  const stillCurrent = later.current
  assert.ok(stillCurrent)
  assert.equal(stillCurrent.startedAt, current.startedAt)
  assert.equal(stillCurrent.endsAt, current.endsAt)
  assert.equal(stillCurrent.tokens, 1000)
  assert.equal(stillCurrent.remainingMs, BLOCK - (2 * HOUR + 30 * 60_000))
})

test('a block is active up to the last millisecond of its window and closed on the instant it ends, leaving no current block behind', async () => {
  const blocks = await freshBlocks()
  blocks.recordUsage(iso(BASE), 500)

  const open = await asIfNow(BASE + BLOCK - 1, () => blocks.blockUsage())
  assert.ok(open.current)
  assert.equal(open.current.remainingMs, 1)

  const closed = await asIfNow(BASE + BLOCK, () => blocks.blockUsage())
  assert.equal(closed.current, null)
  assert.equal(nth(closed.recent, 0).active, false)
  assert.equal(nth(closed.recent, 0).remainingMs, 0)

  // Ten hours later the same finished block still has nothing remaining. Counting down from
  // an end that has passed would make this negative, which the countdown renders as time
  // left rather than as time gone.
  const old = await asIfNow(BASE + 3 * BLOCK, () => blocks.blockUsage())
  assert.equal(nth(old.recent, 0).remainingMs, 0)
})

test('with the token limit unset and no completed block yet, the ceiling is zero, which is the only thing stopping the meter dividing by it', async () => {
  const blocks = await freshBlocks()
  blocks.recordUsage(iso(BASE + HOUR), 5000)

  const usage = await asIfNow(BASE + 2 * HOUR, () => blocks.blockUsage())
  const current = usage.current
  assert.ok(current)
  assert.equal(current.tokens, 5000)
  // This is the default every user hits: no configured limit, and the one block that
  // exists is the one in progress, which is deliberately excluded from the scale.
  assert.equal(usage.ceilingTokens, 0)
  assert.equal(usage.ceilingIsObserved, true)
})

test('with the token limit unset the ceiling is the busiest completed recent block, and the block in progress is left out so a record-breaking block cannot read as exactly full', async () => {
  const blocks = await freshBlocks()
  blocks.recordUsage(iso(BASE), 300)
  blocks.recordUsage(iso(BASE + BLOCK), 900)
  blocks.recordUsage(iso(BASE + 2 * BLOCK), 5000)

  const usage = await asIfNow(BASE + 2 * BLOCK + HOUR, () => blocks.blockUsage())
  assert.ok(usage.current)
  assert.equal(usage.current.tokens, 5000)
  // 900 is the larger of the two finished blocks. Were the active block counted, the
  // ceiling would be its own 5000 and the meter would read 100% for as long as it grew.
  assert.equal(usage.ceilingTokens, 900)
  assert.equal(usage.ceilingIsObserved, true)
})

test('AIVIS_BLOCK_TOKEN_LIMIT overrides the observed ceiling and marks the figure as a real quota rather than a comparison against your own history', async () => {
  const blocks = await freshBlocks({ AIVIS_BLOCK_TOKEN_LIMIT: '1000000' })
  // A completed block far larger than the configured limit must not raise the ceiling:
  // a configured limit is the plan's, not the history's.
  blocks.recordUsage(iso(BASE), 9_000_000)
  blocks.recordUsage(iso(BASE + BLOCK), 250_000)

  const usage = await asIfNow(BASE + BLOCK + HOUR, () => blocks.blockUsage())
  assert.ok(usage.current)
  assert.equal(usage.ceilingTokens, 1_000_000)
  assert.equal(usage.ceilingIsObserved, false)
  // The figure the meter draws from those two numbers: 250k of 1M is a quarter used.
  assert.equal(Math.round((usage.current.tokens / usage.ceilingTokens) * 100), 25)
})

test('the observed ceiling only looks back twelve blocks, so an outlying block older than that stops setting the scale', async () => {
  const blocks = await freshBlocks()
  for (let index = 0; index <= 12; index += 1) {
    blocks.recordUsage(iso(BASE + index * BLOCK), index === 0 ? 999_999 : 100)
  }

  const usage = await asIfNow(BASE + 40 * BLOCK, () => blocks.blockUsage())
  assert.equal(usage.recent.length, 12)
  // Thirteen blocks were recorded, so the outlier is the one that fell off the front.
  assert.equal(nth(usage.recent, 0).startedAt, iso(BASE + BLOCK))
  assert.equal(usage.ceilingTokens, 100)
})

test('AIVIS_BLOCK_HOURS sets the window length, and an unreadable value falls back to five hours rather than to zero', async () => {
  const twoHour = await freshBlocks({ AIVIS_BLOCK_HOURS: '2' })
  twoHour.recordUsage(iso(BASE), 10)
  twoHour.recordUsage(iso(BASE + 2 * HOUR), 20)
  const usage = await asIfNow(BASE + 30 * HOUR, () => twoHour.blockUsage())
  assert.equal(usage.blockHours, 2)
  assert.equal(usage.recent.length, 2)
  assert.equal(nth(usage.recent, 0).endsAt, iso(BASE + 2 * HOUR))

  // A zero-length window would make every hour its own block and every countdown zero, so
  // anything that does not parse has to land back on the default.
  const nonsense = await freshBlocks({ AIVIS_BLOCK_HOURS: 'not-a-number' })
  assert.equal((await nonsense.blockUsage()).blockHours, 5)
})

test('a turn with an unparsable timestamp or no tokens is dropped rather than folded in, which would poison every total it touched', async () => {
  const blocks = await freshBlocks()
  blocks.recordUsage('definitely not a date', 5000)
  blocks.recordUsage(null, 5000)
  blocks.recordUsage(undefined, 5000)
  blocks.recordUsage(iso(BASE), 0)
  blocks.recordUsage(iso(BASE), -100)
  blocks.recordUsage(iso(BASE), 750)

  const usage = await asIfNow(BASE + 30 * BLOCK, () => blocks.blockUsage())
  assert.equal(usage.recent.length, 1)
  assert.equal(nth(usage.recent, 0).tokens, 750)
})

test('todayTokens counts everything recorded since local midnight and nothing from the day before', async (t) => {
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  const from = midnight.getTime()
  // An hour past midnight, so the hour this falls into is on or after midnight in every
  // timezone offset, including the half-hour ones.
  const today = from + 61 * 60_000
  if (Date.now() < today) {
    t.skip('it is not yet an hour past local midnight, so there is no "today" hour to record into')
    return
  }

  const blocks = await freshBlocks()
  blocks.recordUsage(new Date(from - 61 * 60_000).toISOString(), 5000)
  blocks.recordUsage(new Date(today).toISOString(), 700)

  const usage = await blocks.blockUsage()
  assert.equal(usage.todayTokens, 700)
})

test("a session's rate_limit_event is published as a percentage and outranks an older capture from the status line", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aivis-blocks-home-'))
  await fs.mkdir(path.join(home, '.claude'), { recursive: true })
  const nowSeconds = Math.floor(Date.now() / 1000)
  await fs.writeFile(
    path.join(home, '.claude', 'aivis-rate-limits.json'),
    JSON.stringify({
      rate_limits: { five_hour: { used_percentage: 99, resets_at: nowSeconds + 600 } },
      captured_at: nowSeconds - 3600,
    }),
  )

  const blocks = await freshBlocks({ HOME: home })
  // The event states utilization as a fraction; the meter shows a percentage.
  blocks.recordReportedLimits({
    unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: nowSeconds + 3600 } },
  })

  const usage = await blocks.blockUsage()
  const five = usage.reported?.fiveHour
  assert.ok(five)
  // 42, not the file's 99: the live event is the newer of the two captures.
  assert.equal(five.usedPercent, 42)
  assert.equal(five.rolledOver, false)
  assert.ok(five.remainingMs > 59 * 60_000 && five.remainingMs <= 60 * 60_000)
  assert.equal(usage.reported?.stale, false)
})

test('a capture whose reset has already passed keeps its clock but loses its percentage, because the new window began again from nothing', async () => {
  const blocks = await freshBlocks()
  const nowSeconds = Math.floor(Date.now() / 1000)
  blocks.recordReportedLimits({
    unifiedWindows: { five_hour: { utilization: 0.8, resetsAt: nowSeconds - 3600 } },
  })

  const usage = await blocks.blockUsage()
  const five = usage.reported?.fiveHour
  assert.ok(five)
  assert.equal(five.rolledOver, true)
  // Windows run back to back on a fixed grid, so a reset an hour ago means the next one is
  // four hours out. The percentage it carried described the window that ended, so it goes.
  assert.equal(five.usedPercent, null)
  assert.ok(five.remainingMs > 4 * HOUR - 60_000 && five.remainingMs <= 4 * HOUR)
})

test('a capture too old to be rolled onto the current window is discarded, rather than reported with a clock nobody can trust', async () => {
  const blocks = await freshBlocks()
  const nowSeconds = Math.floor(Date.now() / 1000)
  // Sixty days back is more than the 168 five-hour steps the roll-forward loop will take,
  // so it cannot reach the present and the whole capture has to be dropped.
  blocks.recordReportedLimits({
    unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: nowSeconds - 60 * 24 * 3600 } },
  })

  const usage = await blocks.blockUsage()
  assert.equal(usage.reported, null)
})

test('the weekly window is rolled forward by a week rather than by the five-hour block', async () => {
  const blocks = await freshBlocks()
  const nowSeconds = Math.floor(Date.now() / 1000)
  blocks.recordReportedLimits({
    unifiedWindows: {
      five_hour: { utilization: 0.1, resetsAt: nowSeconds + 600 },
      seven_day: { utilization: 0.6, resetsAt: nowSeconds - 24 * 3600 },
    },
  })

  const seven = (await blocks.blockUsage()).reported?.sevenDay
  assert.ok(seven)
  assert.equal(seven.rolledOver, true)
  // A weekly reset a day ago means the next one is six days out. Stepping it by the
  // five-hour block instead would land within the next few hours and tell you a week's
  // quota was about to come back when it is not.
  const DAY = 24 * HOUR
  assert.ok(seven.remainingMs > 6 * DAY - 60_000 && seven.remainingMs <= 6 * DAY)
})

test('a percentage outside nought to a hundred is clamped, because the meter draws it as a width', async () => {
  const over = await freshBlocks()
  const nowSeconds = Math.floor(Date.now() / 1000)
  // Utilization is a fraction, so 1.4 is 140% — a window already past its quota. Drawn
  // unclamped it would overflow the meter rather than fill it.
  over.recordReportedLimits({
    unifiedWindows: { five_hour: { utilization: 1.4, resetsAt: nowSeconds + 600 } },
  })
  assert.equal((await over.blockUsage()).reported?.fiveHour?.usedPercent, 100)

  const under = await freshBlocks()
  under.recordReportedLimits({
    unifiedWindows: { five_hour: { utilization: -0.2, resetsAt: nowSeconds + 600 } },
  })
  assert.equal((await under.blockUsage()).reported?.fiveHour?.usedPercent, 0)
})

test('a capture is flagged stale once it is old enough that the percentage has probably moved on', async () => {
  /** A home directory holding a status-line capture taken `agoSeconds` ago. */
  const homeWithCapture = async (agoSeconds: number): Promise<string> => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aivis-blocks-stale-home-'))
    await fs.mkdir(path.join(home, '.claude'), { recursive: true })
    const nowSeconds = Math.floor(Date.now() / 1000)
    await fs.writeFile(
      path.join(home, '.claude', 'aivis-rate-limits.json'),
      JSON.stringify({
        rate_limits: { five_hour: { used_percentage: 70, resets_at: nowSeconds + 3600 } },
        captured_at: nowSeconds - agoSeconds,
      }),
    )
    return home
  }

  // Nothing has run for half an hour, so the status line has not written since: the clock
  // is still right but the 70% is a figure from before, which is what `stale` says.
  const old = await freshBlocks({ HOME: await homeWithCapture(30 * 60) })
  const oldUsage = await old.blockUsage()
  assert.equal(oldUsage.reported?.stale, true)
  assert.equal(oldUsage.reported?.fiveHour?.usedPercent, 70, 'a stale capture is still shown, just marked')

  const recent = await freshBlocks({ HOME: await homeWithCapture(60) })
  assert.equal((await recent.blockUsage()).reported?.stale, false)
})
