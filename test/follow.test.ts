import { test } from 'node:test'
import assert from 'node:assert/strict'
import { atBottom, stillFollowing, type ScrollPosition } from '../web/follow.ts'

/*
 * These pin the rule that decides whether the conversation keeps scrolling to new output.
 * Every case below is one the position-reading version got wrong, and each of them showed
 * up as the same symptom: the page silently stopped following and never started again.
 */

/** A window 800 tall onto a conversation 5,000 tall, scrolled to `top`. */
const at = (top: number, height = 5000, view = 800): ScrollPosition => ({ top, height, view })

/** Where the bottom is for that window: 5000 - 800. */
const BOTTOM = 4200

test('the end of the conversation counts as the bottom, and so does a line short of it', () => {
  assert.equal(atBottom(at(BOTTOM)), true)
  assert.equal(atBottom(at(BOTTOM - 79)), true, 'within the slack')
  assert.equal(atBottom(at(BOTTOM - 81)), false, 'past it')
})

test('a conversation shorter than its window is always at the bottom, so a new session follows', () => {
  assert.equal(atBottom({ top: 0, height: 300, view: 800 }), true)
})

test('scrolling up stops the page following, which is the one thing the reader can mean by it', () => {
  assert.equal(stillFollowing(true, 3000, at(2000)), false)
})

/*
 * The bug this module exists for. A pin scrolls down, and if its scroll event is delivered
 * late — after the content it was chasing has grown taller — the position reads as far from
 * the bottom although the reader never touched anything. Reading the position called that
 * "scrolled away" and stopped following for good.
 */
test('a pin whose scroll event arrives late, after the content grew, does not stop the page following', () => {
  // Pinned to the bottom of a 5,000-tall transcript, then 3,000 more pixels of answer land
  // before the event is handled. The position has not moved; the bottom has moved away.
  const grown = { top: BOTTOM, height: 8000, view: 800 }
  assert.equal(atBottom(grown), false, 'the gap really is large')
  assert.equal(stillFollowing(true, BOTTOM, grown), true, 'but nobody scrolled up, so it keeps following')
})

/*
 * The other half of the same bug. An animated scroll reports every position on its way
 * down, each of them part-way up the transcript.
 */
test('an animated scroll on its way down never reads as the reader scrolling away', () => {
  let following = true
  let previous = 0
  // A smooth pin stepping down towards the bottom of a transcript that is still growing.
  for (const top of [500, 1400, 2600, 3500, 4100, BOTTOM]) {
    following = stillFollowing(following, previous, { top, height: 9000, view: 800 })
    previous = top
    assert.equal(following, true, `stopped following part-way down at ${top}`)
  }
})

test('following resumes when the reader comes back to the end, so it can never be stuck off', () => {
  let following = stillFollowing(true, 4000, at(1000))
  assert.equal(following, false, 'they scrolled up')
  // Growth while they read elsewhere must not drag them back.
  following = stillFollowing(following, 1000, { top: 1000, height: 12000, view: 800 })
  assert.equal(following, false, 'and stays off while they are reading history')
  // Then they scroll back down to the end themselves.
  following = stillFollowing(following, 1000, at(BOTTOM))
  assert.equal(following, true)
})

test('content growing under a reader parked in history never turns following back on', () => {
  let following = false
  let previous = 1000
  for (const height of [6000, 7000, 9000, 14000]) {
    following = stillFollowing(following, previous, { top: 1000, height, view: 800 })
    previous = 1000
    assert.equal(following, false)
  }
})

test('a scroll that does not move is not a direction, so it decides nothing', () => {
  assert.equal(stillFollowing(false, 2000, at(2000)), false)
  assert.equal(stillFollowing(true, 2000, at(2000)), true)
})

test('a sub-pixel wobble is not the reader scrolling up, since positions are fractional', () => {
  assert.equal(stillFollowing(true, 2000, at(1999.5)), true)
  assert.equal(stillFollowing(true, 2000, at(1998)), false, 'but two pixels is')
})

/*
 * The composer growing at the end of a turn shrinks the window without moving the reader,
 * which moves the bottom away from them. Nobody scrolled, so nothing changes.
 */
test('the window shrinking under the reader does not read as them scrolling away', () => {
  const before = { top: BOTTOM, height: 5000, view: 800 }
  assert.equal(atBottom(before), true)
  const after = { top: BOTTOM, height: 5000, view: 600 }
  assert.equal(atBottom(after), false, 'the bottom moved away')
  assert.equal(stillFollowing(true, BOTTOM, after), true, 'so the pin is still wanted')
})
