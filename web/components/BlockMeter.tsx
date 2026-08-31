import { useBlockUsage } from '../useBlockUsage.ts'

/** Format a millisecond span as `4h 59m` or `47m`. */
function left(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000))
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

function short(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

/**
 * How far into the current rate-limit block this account is.
 *
 * When the status line has published Claude Code's own rate-limit state, that is what the
 * meter shows: the real percentage and the real reset clock, the same numbers the CLI
 * displays. Without it aivis falls back to deriving a figure from the transcripts against
 * your busiest recent block, which compares you to your own history rather than to a quota
 * — the tooltip says so, because the two mean very different things.
 */
export function BlockMeter(): React.JSX.Element | null {
  const usage = useBlockUsage()

  if (!usage) return null

  const five = usage.reported?.fiveHour
  const block = usage.current

  // The reported figure is the real one, so it wins whenever it is there. A percentage of
  // null is not zero: it is a window whose usage nobody has reported yet, and the meter has
  // to be able to say that rather than draw an empty bar that reads as "nothing used".
  let percent: number | null
  let remainingMs: number
  let hint: string
  let derived = false

  if (five) {
    remainingMs = five.remainingMs
    const weekly = usage.reported?.sevenDay
    const weeklyNote =
      weekly && weekly.usedPercent !== null
        ? `Weekly limit: ${Math.round(weekly.usedPercent)}% used, resetting in ${left(weekly.remainingMs)}. `
        : ''
    if (five.usedPercent === null) {
      // The capture described a window that has since ended. Its clock still holds, because
      // the windows run back to back, but its percentage described a window that is over.
      percent = null
      hint =
        `A new 5-hour window has started and resets in ${left(remainingMs)}. ` +
        `How much of it is used has not been reported yet: the last reading Claude Code published was for the window before this one. ` +
        weeklyNote +
        `Any session aivis drives refreshes this as soon as it runs.`
    } else {
      percent = Math.min(100, Math.round(five.usedPercent))
      hint =
        `${percent}% of your 5-hour limit used, resetting in ${left(remainingMs)}. ` +
        weeklyNote +
        `Reported by Claude Code itself, so this matches the CLI's status line.` +
        (usage.reported?.stale ? ' This capture is over 15 minutes old and may have moved on.' : '')
    }
  } else if (block) {
    derived = true
    remainingMs = block.remainingMs
    const ceiling = usage.ceilingTokens
    if (!ceiling) {
      // Nothing finished to compare against, so there is no scale and no percentage. The
      // token count is still worth showing; a made-up percentage is not.
      percent = null
      hint =
        `${short(block.tokens)} tokens so far in this ${usage.blockHours}-hour block. ` +
        `There is no completed block to compare it against yet, so aivis has no scale to put it on. ` +
        `For the real figure, let the status line publish it (see the README) or set AIVIS_BLOCK_TOKEN_LIMIT.`
    } else {
      percent = Math.min(100, Math.round((block.tokens / ceiling) * 100))
      hint = usage.ceilingIsObserved
        ? `Estimated: ${short(block.tokens)} tokens this ${usage.blockHours}-hour block, against ${short(ceiling)} in your busiest completed block — a comparison against your own history, not your plan's quota. For the real figure, let the status line publish it (see the README) or set AIVIS_BLOCK_TOKEN_LIMIT.`
        : `Estimated: ${short(block.tokens)} of ${short(ceiling)} tokens in this ${usage.blockHours}-hour block.`
    }
  } else {
    return null
  }

  // An unknown percentage is never hot. Colour follows a number that exists.
  const tone =
    percent === null ? '' : percent >= 90 ? 'blockmeter--hot' : percent >= 60 ? 'blockmeter--warm' : ''

  return (
    <span className={`blockmeter ${tone}`} title={hint}>
      block
      <span className={`blockmeter__bar ${percent === null ? 'blockmeter__bar--unknown' : ''}`}>
        <i style={{ width: `${percent ?? 0}%` }} />
      </span>
      <span className="blockmeter__pct">
        {percent === null ? '—' : `${derived ? '≈' : ''}${percent}%`}
      </span>
      <span className="blockmeter__left">{left(remainingMs)} left</span>
    </span>
  )
}
