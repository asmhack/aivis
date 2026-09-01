import type { AttentionItem } from '../shared/types.ts'
import { NOTIFIED_KINDS } from './notify.ts'

/**
 * The count aivis wears on its own tab.
 *
 * A system notification is the loud way to be told, and it is also the one aivis cannot
 * verify: the browser accepts the call, reports that it showed the banner, and the operating
 * system may still have dropped it — for an app-level permission, a Focus mode, an alert
 * style set to none — with nothing said to the page either way. `show` fires even in a
 * headless browser that has no screen at all, so there is no answer to be had from asking.
 *
 * This is the quiet way, and it is the one that cannot fail. The tab's title and its icon
 * belong to the page, so nothing outside the browser can suppress them, no permission is
 * asked for, and a glance at the tab strip answers "is anything waiting on me" whether or
 * not a banner was ever delivered. The notification is the escalation; this is the floor.
 */

/**
 * How many things are waiting on you, for the purpose of wearing it on the tab.
 *
 * The same two kinds the notification covers, deliberately, so the tab and the banner never
 * disagree about how much needs you. The queue on the page shows a third — a session that
 * has gone quiet without saying why — because you are already looking at the page when you
 * read it; that is a lower bar than being interrupted, and a lower bar than a number that
 * follows you into every other tab you open.
 */
export function needing(items: AttentionItem[]): number {
  return items.filter((item) => NOTIFIED_KINDS.includes(item.kind)).length
}

/**
 * The document title for a given count.
 *
 * The count leads, because a title is read from the left and a tab is usually too narrow to
 * show much more than that. Zero is the name alone rather than `(0) aivis`, so a fleet that
 * needs nothing looks like it needs nothing.
 */
export function titleFor(count: number, base = 'aivis'): string {
  return count > 0 ? `(${count}) ${base}` : base
}

/**
 * What the favicon says, which is less than the title has room for.
 *
 * Past a point the glyph is unreadable at sixteen pixels, so the count stops being a number
 * and becomes "more than that". The threshold is low on purpose: `9+` is legible where `12`
 * is a smudge.
 */
export function badgeText(count: number): string {
  if (count <= 0) return ''
  return count > 9 ? '9+' : String(count)
}
