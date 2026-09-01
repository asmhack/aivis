import type { AttentionItem, AttentionKind } from '../shared/types.ts'

/**
 * What the browser is told, and about which rows.
 *
 * The index already says what needs you; a notification says it when you are not looking.
 * So the queue stays the single source of what is urgent and this module only decides
 * three things on top of it: which kinds are worth interrupting for, which items are news
 * rather than the state of the world when you started watching, and how one of them reads
 * in a banner. The browser wiring — permission, visibility, the notification itself —
 * lives in `useNotify.ts`, because none of it can be exercised outside a browser and all
 * of the decisions below can.
 */

/**
 * The kinds worth a banner.
 *
 * `asking` is a session holding a turn open for an answer and `waiting` is one that has
 * finished its turn, which are the two things you would want fetching from another window
 * for. `stalled` is deliberately absent: it means only that a live session has gone quiet
 * without saying why, which is as often a long build as a problem, so notifying on it
 * would spend your attention on sessions that are fine.
 */
export const NOTIFIED_KINDS: readonly AttentionKind[] = ['asking', 'waiting']

/**
 * How many item ids are remembered as already announced.
 *
 * Far more than a fleet ever holds at once, because the cost of forgetting one is a
 * duplicate banner for something you have already been told about, and the cost of keeping
 * it is a string.
 */
export const SEEN_MAX = 500

/** Longest body a banner is given, past which the operating system would clip it anyway. */
const BODY_MAX = 180

/** What one banner says. */
export interface Notice {
  title: string
  body: string
  /**
   * Groups a session's banners so a new one replaces the last rather than stacking.
   *
   * A session that asks, gets answered, and then finishes its turn would otherwise leave
   * three banners describing states it is no longer in. Keyed by session so the newest
   * thing known about each one is the only thing on screen for it.
   */
  tag: string
}

/**
 * The items in this queue that have not been announced yet.
 *
 * An item's id changes whenever the state it describes changes, which is the property the
 * dismiss list already relies on, and it is exactly what is wanted here too: a session
 * that stops, runs again, and stops again is news twice, while the same wait re-read on
 * the next poll is news once.
 */
export function arrivals(items: AttentionItem[], seen: Set<string>): AttentionItem[] {
  return items.filter((item) => NOTIFIED_KINDS.includes(item.kind) && !seen.has(item.id))
}

/**
 * Fold the queue as it stands into what has been announced.
 *
 * Every id present is recorded, not just the ones that raised a banner, so that a kind
 * suppressed today — or an item you were looking at when it arrived — cannot come back as
 * news tomorrow. When the cap is reached the oldest ids go first, except that anything
 * still in the queue is kept regardless of age: dropping an id for an item that is on
 * screen right now is the one eviction that would announce it a second time.
 */
export function remember(
  seen: Set<string>,
  items: AttentionItem[],
  cap = SEEN_MAX,
): Set<string> {
  const present = new Set(items.map((item) => item.id))
  const next = new Set(seen)
  for (const id of present) next.add(id)
  if (next.size <= cap) return next
  for (const id of next) {
    if (next.size <= cap) break
    if (!present.has(id)) next.delete(id)
  }
  return next
}

/**
 * Whether you are already watching the session a banner would be about.
 *
 * Notifications exist for the moment you are elsewhere, so something has to decide when
 * they would only repeat what is in front of you. That something is narrow on purpose: a
 * session page shows one conversation, and a banner announcing that the conversation you
 * are reading has finished its turn tells you nothing you did not just watch happen.
 *
 * The fleet page is deliberately not counted, though it carries the queue and every row in
 * it. A row appearing in a list is not the same as having read the list — the index is
 * precisely where aivis is left open while the work happens somewhere else, and treating a
 * focused index as having seen everything meant a row could arrive, be suppressed, and be
 * marked as told about, so that tabbing away a second later produced silence. Between a
 * banner you did not need and no banner at all, only one of the two is a broken feature.
 */
export function onScreen(item: AttentionItem, openSessionId: string | null): boolean {
  return openSessionId === item.sessionId
}

/** Trim a line to what a banner will show, marking where it was cut. */
function clip(text: string, max = BODY_MAX): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

/**
 * How one queue item reads as a banner.
 *
 * A banner is read in a second, out of the corner of an eye, with no queue around it for
 * context — so the title answers "which session, and what does it want" and the body
 * carries the one line that says why. For a session that is asking, that line is the
 * question itself; for one that has finished its turn there is nothing it wants, so the
 * body is the session's own title, which is the prompt it opened with and the only thing
 * that tells two sessions in the same project apart.
 */
export function describe(item: AttentionItem): Notice {
  const tag = `aivis:${item.sessionId}`
  const project = item.projectName
  if (item.kind === 'asking') {
    return {
      // A permission prompt and a question are both blocking, but only one of them is a
      // question, and saying so is what tells you whether to expect a decision or a reply.
      title: item.askKind === 'permission' ? `${project} needs a decision` : `${project} is asking you`,
      body: clip(item.ask?.question ?? item.title),
      tag,
    }
  }
  if (item.kind === 'stalled') {
    return { title: `${project} has gone quiet`, body: clip(item.title), tag }
  }
  return { title: `${project} finished its turn`, body: clip(item.title), tag }
}
