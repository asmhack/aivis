/**
 * Token usage grouped into rate-limit blocks.
 *
 * Claude Code meters usage in fixed windows — five hours by default — and the CLI's
 * status line shows how far into the current one you are. Nothing on disk states the
 * window or your plan's ceiling, so both are derived here: the window from a constant,
 * the ceiling from the largest block you have actually run.
 *
 * Usage is accumulated per hour as transcripts are read, which keeps the whole history
 * in a few thousand numbers rather than a record per turn.
 */

const HOUR_MS = 3600_000

const BLOCK_HOURS = Number(process.env.AIVIS_BLOCK_HOURS ?? 5) || 5
const BLOCK_MS = BLOCK_HOURS * HOUR_MS

/** An explicit ceiling, when you know your plan's real limit. */
const CONFIGURED_LIMIT = Number(process.env.AIVIS_BLOCK_TOKEN_LIMIT ?? 0) || 0

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Block, BlockUsage, ReportedLimit, ReportedUsage } from '../shared/types.ts'

/**
 * Where the status line publishes Claude Code's real rate-limit state.
 *
 * Claude Code hands the status line the authoritative numbers on stdin and writes them
 * nowhere else, so a line in that script tees them here. Without it aivis can only derive
 * a comparison against your own history, which is a different and much weaker thing.
 */
const REPORTED_PATH = path.join(os.homedir(), '.claude', 'aivis-rate-limits.json')

/** A capture older than this is shown as stale: the percentage has probably moved on. */
const STALE_AFTER_MS = 15 * 60_000

interface RawLimit {
  used_percentage?: number
  resets_at?: number
}

/**
 * Shape one reported window, rolling it forward if its reset has already passed.
 *
 * Rate-limit windows run back to back on a fixed grid — a reset observed at 13:40 is
 * followed by one at 18:40, exactly `windowMs` later — so a capture whose window has ended
 * still says precisely when the current one ends. What it no longer says is how much of
 * that window is gone, because usage began again from nothing at the reset, so the
 * percentage is dropped rather than carried into a window it never described. That is the
 * bug this replaces: an expired capture used to be discarded whole, which sent the meter
 * to a derived figure that had neither the right percentage nor the right clock.
 */
function toReported(
  raw: RawLimit | undefined,
  now: number,
  windowMs: number,
): ReportedLimit | null {
  if (!raw || typeof raw.used_percentage !== 'number' || typeof raw.resets_at !== 'number') return null
  let resetsAt = raw.resets_at * 1000
  if (!Number.isFinite(resetsAt)) return null

  let rolledOver = false
  // A capture old enough to have skipped whole windows still lands on the grid, so this
  // steps rather than adding once. The guard keeps a nonsense timestamp from spinning.
  const limit = 24 * 7
  for (let step = 0; resetsAt <= now && step < limit; step += 1) {
    resetsAt += windowMs
    rolledOver = true
  }
  if (resetsAt <= now) return null

  return {
    usedPercent: rolledOver ? null : Math.max(0, Math.min(100, raw.used_percentage)),
    resetsAt: new Date(resetsAt).toISOString(),
    remainingMs: Math.max(0, resetsAt - now),
    rolledOver,
  }
}

/**
 * The freshest rate-limit state a running session has reported.
 *
 * Claude Code emits a `rate_limit_event` on the stream of any session started in
 * stream-json mode, carrying the same numbers its status line shows. Limits are
 * account-wide, so whichever session reports one is reporting for all of them, and a single
 * driven session keeps the meter honest for the whole fleet. This is the live source; the
 * file the status line writes is the one that covers sessions aivis does not drive.
 */
let live: { fiveHour: RawLimit; sevenDay: RawLimit | null; at: number } | null = null

interface RawWindow {
  utilization?: number
  resetsAt?: number
}

/** Fold one window from a `rate_limit_event` into the shape the file uses. */
function fromWindow(window: RawWindow | undefined): RawLimit | null {
  if (!window || typeof window.utilization !== 'number' || typeof window.resetsAt !== 'number') {
    return null
  }
  // The event states utilization as a fraction where the status line states a percentage.
  return { used_percentage: window.utilization * 100, resets_at: window.resetsAt }
}

/** Record the rate-limit state carried by a session's `rate_limit_event`. */
export function recordReportedLimits(info: unknown): void {
  if (!info || typeof info !== 'object') return
  const windows = (info as { unifiedWindows?: { five_hour?: RawWindow; seven_day?: RawWindow } })
    .unifiedWindows
  const fiveHour = fromWindow(windows?.five_hour)
  if (!fiveHour) return
  live = { fiveHour, sevenDay: fromWindow(windows?.seven_day), at: Date.now() }
}

/**
 * Read the rate-limit state the status line published.
 *
 * Returns null whenever the capture cannot be trusted — missing, unreadable, or past its
 * reset — so the caller falls back to the derived numbers rather than showing stale ones.
 */
async function readReported(): Promise<ReportedUsage | null> {
  let fromFile: { five: RawLimit | undefined; seven: RawLimit | undefined; at: number } | null =
    null
  try {
    const parsed = JSON.parse(await fs.readFile(REPORTED_PATH, 'utf8')) as {
      rate_limits?: { five_hour?: RawLimit; seven_day?: RawLimit }
      captured_at?: number
    }
    fromFile = {
      five: parsed.rate_limits?.five_hour,
      seven: parsed.rate_limits?.seven_day,
      at: typeof parsed.captured_at === 'number' ? parsed.captured_at * 1000 : 0,
    }
  } catch {
    fromFile = null
  }

  // Two sources report the same account-wide numbers: the status line's file, which covers
  // sessions aivis does not drive, and the stream event, which arrives whenever aivis drives
  // one. The newer capture wins, because the only thing that separates them is age.
  const candidates = [
    live ? { five: live.fiveHour, seven: live.sevenDay ?? undefined, at: live.at } : null,
    fromFile,
  ].filter((entry): entry is { five: RawLimit | undefined; seven: RawLimit | undefined; at: number } =>
    entry !== null && entry.five !== undefined,
  )
  if (candidates.length === 0) return null
  const best = candidates.reduce((newest, entry) => (entry.at > newest.at ? entry : newest))

  const now = Date.now()
  const fiveHour = toReported(best.five, now, BLOCK_MS)
  if (!fiveHour) return null
  // The weekly window is on its own grid, so it is rolled forward by its own length.
  const sevenDay = toReported(best.seven, now, 7 * 24 * HOUR_MS)

  return {
    fiveHour,
    sevenDay,
    capturedAt: new Date(best.at || now).toISOString(),
    stale: best.at > 0 && now - best.at > STALE_AFTER_MS,
  }
}

const hours = new Map<number, number>()

/** How many recent blocks the observed ceiling is taken from. */
const RECENT_BLOCKS = 12

/** Fold one assistant turn's tokens into the hour it happened in. */
export function recordUsage(timestamp: string | null | undefined, tokens: number): void {
  if (!timestamp || tokens <= 0) return
  const at = new Date(timestamp).getTime()
  if (!Number.isFinite(at)) return
  const hour = Math.floor(at / HOUR_MS) * HOUR_MS
  hours.set(hour, (hours.get(hour) ?? 0) + tokens)
}

/** Everything recorded since local midnight, which is what "today" means to a person. */
function todayTotal(): number {
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  const from = midnight.getTime()
  let total = 0
  for (const [hour, tokens] of hours) {
    if (hour >= from) total += tokens
  }
  return total
}

/**
 * Group the recorded hours into blocks.
 *
 * A block opens on the first hour with activity and runs for `BLOCK_HOURS`. Hours after
 * it that fall outside open the next block, so a long idle stretch produces a gap rather
 * than a run of empty windows.
 */
function buildBlocks(): Block[] {
  const keys = [...hours.keys()].sort((a, b) => a - b)
  if (keys.length === 0) return []

  const now = Date.now()
  const blocks: Block[] = []
  let start = keys[0] as number
  let total = 0

  for (const hour of keys) {
    if (hour >= start + BLOCK_MS) {
      blocks.push(toBlock(start, total, now))
      start = hour
      total = 0
    }
    total += hours.get(hour) ?? 0
  }
  blocks.push(toBlock(start, total, now))
  return blocks
}

function toBlock(start: number, tokens: number, now: number): Block {
  const end = start + BLOCK_MS
  const active = now >= start && now < end
  return {
    startedAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    tokens,
    active,
    remainingMs: active ? end - now : 0,
  }
}

export async function blockUsage(): Promise<BlockUsage> {
  const blocks = buildBlocks()
  const recent = blocks.slice(-RECENT_BLOCKS)
  // A ceiling taken from all history is dominated by one outlying day, which pins every
  // later block near zero. The busiest recent block is a scale you can actually read.
  //
  // The block in progress is left out of it. Including it made the ceiling rise with the
  // very number being measured, so any block that grew past every earlier one read as
  // exactly 100% for as long as it kept growing — a full meter that meant nothing but "this
  // is your busiest block yet". With no completed block to compare against there is no
  // scale at all, and a ceiling of zero is what tells the meter to say so.
  const observed = recent
    .filter((block) => !block.active)
    .reduce((most, block) => Math.max(most, block.tokens), 0)
  return {
    reported: await readReported(),
    current: blocks.find((block) => block.active) ?? null,
    ceilingTokens: CONFIGURED_LIMIT || observed,
    ceilingIsObserved: CONFIGURED_LIMIT === 0,
    blockHours: BLOCK_HOURS,
    recent,
    todayTokens: todayTotal(),
  }
}
