/**
 * The count aivis wears on its own tab, and the rule that decides which queue to believe.
 *
 * Both exist because of the same failure. A system notification is the loud signal and the
 * one aivis cannot verify — the browser reports that it showed the banner even when there is
 * no screen to show it on — so a machine configured to give the browser no banner produces
 * total silence that looks exactly like broken code. The tab is the signal that cannot be
 * suppressed from outside the page, which makes it the floor the feature stands on rather
 * than a decoration on top of it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { badgeText, needing, titleFor } from '../web/badge.ts'
import { preferredQueue } from '../web/useAttention.ts'
import type { AttentionItem, AttentionKind } from '../shared/types.ts'

function item(over: Partial<AttentionItem> = {}): AttentionItem {
  const kind: AttentionKind = over.kind ?? 'waiting'
  const sessionId = over.sessionId ?? 'sess-1'
  return {
    id: `${kind}:${sessionId}:2026-09-01T08:00:00.000Z`,
    kind,
    sessionId,
    projectName: 'app',
    cwd: '/work/app',
    title: 'ship the thing',
    toolName: null,
    toolDetail: null,
    since: '2026-09-01T08:00:00.000Z',
    ask: null,
    askKind: null,
    answerable: false,
    ...over,
  }
}

test('the tab counts the same two kinds the banner does, so the two never disagree', () => {
  const queue = [item({ kind: 'asking', sessionId: 'a' }), item({ sessionId: 'b' })]
  assert.equal(needing(queue), 2)
})

/*
 * The queue on the page shows a third kind, and the tab deliberately does not. Being looked
 * at is a lower bar than following someone into every other tab they open, and a session that
 * has merely gone quiet is as often a long command as a problem.
 */
test('a stalled session is not worn on the tab, for the same reason it raises no banner', () => {
  assert.equal(needing([item({ kind: 'stalled' })]), 0)
})

test('a fleet that needs nothing looks like it needs nothing', () => {
  assert.equal(titleFor(0), 'aivis')
  assert.equal(titleFor(2), '(2) aivis')
})

/*
 * A tab is read from the left and is usually too narrow to show much, so the count leads. The
 * icon has even less room: past a point a two-digit number at sixteen pixels is a smudge.
 */
test('the icon stops counting where the glyph would stop being legible', () => {
  assert.equal(badgeText(0), '')
  assert.equal(badgeText(9), '9')
  assert.equal(badgeText(10), '9+')
})

/*
 * Which queue to believe. The socket is the better source and cannot be the only one: a
 * server older than the build that added the pushed message never sends it, and a socket that
 * has dropped stops sending it without saying so. Neither may look like a fleet gone quiet.
 */
test('the socket wins while it is open and has spoken', () => {
  const pushed = [item({ sessionId: 'pushed' })]
  const polled = [item({ sessionId: 'polled' })]
  assert.deepEqual(preferredQueue(pushed, true, polled, true).items, pushed)
})

test('a server too old to push leaves the poll in charge', () => {
  const polled = [item({ sessionId: 'polled' })]
  const got = preferredQueue(null, true, polled, true)
  assert.deepEqual(got.items, polled)
  assert.equal(got.loaded, true)
})

test('a dropped socket hands back to the poll rather than going on quoting stale news', () => {
  const pushed = [item({ sessionId: 'pushed' })]
  const polled = [item({ sessionId: 'polled' })]
  assert.deepEqual(preferredQueue(pushed, false, polled, true).items, polled)
})

/*
 * The gap between the socket dropping and the poll answering. What the socket last said is
 * stale by seconds; an empty queue would be a claim that nothing needs you, which is the one
 * answer that must never be invented.
 */
test('between the two, the last thing the socket said stands in — never an empty queue', () => {
  const pushed = [item({ sessionId: 'pushed' })]
  assert.deepEqual(preferredQueue(pushed, false, [], false).items, pushed)
})

test('before either source has spoken, the queue is not loaded rather than empty', () => {
  const got = preferredQueue(null, false, [], false)
  assert.deepEqual(got.items, [])
  assert.equal(got.loaded, false, 'an unread queue must not arm the notifier')
})
