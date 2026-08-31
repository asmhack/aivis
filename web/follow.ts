/**
 * Whether the conversation keeps following new output.
 *
 * The page pins itself to the end of the transcript while the reader is watching it, and
 * leaves their position alone once they scroll back through history. Deciding which of
 * those is happening turns out to be the whole problem, because a `scroll` event says what
 * the position is and never who moved it.
 *
 * Reading the position was the first answer and it does not work. The handler cannot tell
 * its own pin from the reader: a scroll event can be delivered after the frame that caused
 * it, an animated scroll reports every intermediate position on its way down, and content
 * arriving between the pin and the handler leaves the measurement showing a large gap
 * although nobody moved. Any one of those reads as "scrolled away", and it sticks — once
 * following is off nothing re-pins, so it never comes back on its own. The symptom was that
 * a long final answer, the biggest jump and so the likeliest to lose the race, was the one
 * message the page would not scroll to.
 *
 * Direction settles it without needing to know who moved. Pinning only ever scrolls down.
 * Content arriving does not move `top` at all — it grows `height` underneath it. So a `top`
 * that went *down* is the reader, whatever fired the event and however late it arrived.
 * That is the whole rule, and it holds whether the scroll was instant or animated, which is
 * why nothing here depends on the timing of anything.
 */

/** How close to the end still counts as watching it. */
const BOTTOM_SLACK = 80

export interface ScrollPosition {
  /** How far the reader has scrolled from the top. */
  top: number
  /** The full height of the conversation. */
  height: number
  /** The height of the window onto it. */
  view: number
}

/** Whether the end of the conversation is on screen, give or take a line. */
export function atBottom(now: ScrollPosition): boolean {
  return now.height - now.top - now.view <= BOTTOM_SLACK
}

/**
 * Decide whether to keep following, given where a scroll left the reader.
 *
 * `previousTop` is where the last scroll left them, which is what makes a direction out of
 * two positions. Nothing else is needed: no flag saying a scroll was ours, and no window in
 * which events are ignored.
 */
export function stillFollowing(following: boolean, previousTop: number, now: ScrollPosition): boolean {
  // Arriving at the end asks to be followed again, whoever did the scrolling. This is also
  // what lets following recover, which the position-reading version could not do.
  if (atBottom(now)) return true
  // Scrolling up is the reader saying they are reading something else now. A pin never does
  // this, and neither does new output, so no other explanation has to be ruled out. The
  // single pixel of tolerance is for fractional device-pixel positions.
  if (now.top < previousTop - 1) return false
  return following
}
