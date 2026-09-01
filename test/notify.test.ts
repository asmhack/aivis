/**
 * What gets announced to the operating system, and — mostly — what does not.
 *
 * A notification is the one thing aivis does that reaches you when you are not looking at
 * it, so a wrong one costs far more than a missing one: it pulls you out of another window
 * for a session that is fine. Every assertion here is about restraint. Only two of the
 * queue's three kinds are worth a banner, an item is announced once no matter how many
 * times the queue is polled, and the queue as it stood when you switched notifications on
 * is the state of the world rather than news.
 *
 * The browser half — permission, focus, the `Notification` itself — is in `useNotify.ts`
 * and needs a browser. Everything decided before that point is here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advance, arrivals, describe, onScreen, remember, SEEN_MAX, unarmed } from '../web/notify.ts'
import type { AttentionItem, AttentionKind } from '../shared/types.ts'

/** One queue row, defaulting to the `waiting` case: a session that finished its turn. */
function item(over: Partial<AttentionItem> = {}): AttentionItem {
  const kind: AttentionKind = over.kind ?? 'waiting'
  const sessionId = over.sessionId ?? 'b8e04d71-0000-4000-8000-000000000001'
  return {
    id: `${kind}:${sessionId}:2026-09-01T08:00:00.000Z`,
    kind,
    sessionId,
    projectName: 'app',
    cwd: '/work/app',
    title: 'ship the thing',
    toolName: 'Bash',
    toolDetail: 'npm test',
    since: '2026-09-01T08:00:00.000Z',
    ask: null,
    askKind: null,
    answerable: false,
    ...over,
  }
}

const asking = (over: Partial<AttentionItem> = {}): AttentionItem =>
  item({
    kind: 'asking',
    askKind: 'question',
    ask: {
      toolUseId: 'toolu_01DzpS9P1WJGAduc6eeEzaPT',
      header: 'Branch',
      question: 'Which branch should this land on?',
      count: 1,
      at: '2026-09-01T08:00:00.000Z',
    },
    ...over,
  })

test('a session asking you and a session that finished its turn are announced', () => {
  const queue = [asking(), item()]
  assert.deepEqual(
    arrivals(queue, new Set()).map((row) => row.kind),
    ['asking', 'waiting'],
  )
})

test('a stalled session is not announced, because going quiet is as often a long build as a problem', () => {
  assert.deepEqual(arrivals([item({ kind: 'stalled' })], new Set()), [])
})

test('an item is announced once, however many times the queue is polled', () => {
  const queue = [item()]
  const seen = remember(new Set(), queue)
  assert.deepEqual(arrivals(queue, seen), [])
})

/*
 * The property the whole scheme rests on, and the same one the dismiss list uses: an id
 * carries the state it describes. Without it there would be no way to tell a wait being
 * re-read from a session that stopped a second time, and the second one is the news.
 */
test('a session that moves on and stops again is announced again, because that is a new wait', () => {
  const first = item({ id: 'waiting:s1:2026-09-01T08:00:00.000Z' })
  const seen = remember(new Set(), [first])
  const second = item({ id: 'waiting:s1:2026-09-01T09:30:00.000Z' })
  assert.deepEqual(
    arrivals([second], seen).map((row) => row.id),
    ['waiting:s1:2026-09-01T09:30:00.000Z'],
  )
})

test('a kind that is never announced is still remembered, so turning it on later is not a backlog', () => {
  const seen = remember(new Set(), [item({ kind: 'stalled' })])
  assert.equal(seen.size, 1)
})

test('past the cap the oldest ids are forgotten first', () => {
  const old = new Set(Array.from({ length: SEEN_MAX }, (_, n) => `waiting:old${n}`))
  const next = remember(old, [item({ id: 'waiting:new' })])
  assert.equal(next.size, SEEN_MAX)
  assert.equal(next.has('waiting:old0'), false, 'the oldest went')
  assert.equal(next.has('waiting:new'), true)
})

/*
 * The one eviction that would be visible as a bug rather than as forgetting: dropping an id
 * for a row that is still in the queue announces it a second time on the very next poll.
 */
test('an id for a row still in the queue is kept whatever the cap says', () => {
  const standing = item({ id: 'waiting:standing' })
  const full = remember(new Set(), [standing])
  const churn = Array.from({ length: SEEN_MAX * 2 }, (_, n) => item({ id: `waiting:churn${n}` }))
  const next = remember(full, [standing, ...churn])
  assert.equal(next.has('waiting:standing'), true)
  assert.deepEqual(arrivals([standing], next), [])
})

/*
 * The rule that decides when a banner would only repeat what is in front of you, and it is
 * narrow on purpose. It once counted a focused fleet page as having seen every row on it,
 * which sounds reasonable and is not: a row could arrive, be suppressed, and be marked as
 * told about, so tabbing away a second later produced silence for ever. Watching the index
 * for a notification is exactly what someone does when they first switch this on, and it
 * was the one case guaranteed to look broken.
 */
test('the fleet page does not count as seeing a row, because a list is not read by being open', () => {
  assert.equal(onScreen(item({ sessionId: 's1' }), null), false)
})

test('a session page counts as watching that session, and only that one', () => {
  assert.equal(onScreen(item({ sessionId: 's1' }), 's1'), true)
  assert.equal(onScreen(item({ sessionId: 's2' }), 's1'), false)
})

test('a question is announced as one, and the question itself is the line you read', () => {
  const notice = describe(asking())
  assert.equal(notice.title, 'app is asking you')
  assert.equal(notice.body, 'Which branch should this land on?')
})

/*
 * A permission prompt and a question both hold the turn open, but only one of them is a
 * question, and the banner has to say which — allow-or-deny and write-me-an-answer are not
 * the same errand to be pulled out of another window for.
 */
test('a permission prompt is announced as a decision, not a question', () => {
  const notice = describe(asking({ askKind: 'permission' }))
  assert.equal(notice.title, 'app needs a decision')
})

test('a finished turn is announced with the prompt the session opened with, which names it', () => {
  const notice = describe(item())
  assert.equal(notice.title, 'app finished its turn')
  assert.equal(notice.body, 'ship the thing')
})

/*
 * The regression that made the whole feature look like code that never ran. Banners were once
 * tagged by session so a newer one replaced the last, which is defined to happen *quietly* —
 * so the second and every later banner for a session arrived with no alert, and nothing
 * anywhere reported that it had been coalesced. Two distinct events must never share a tag.
 */
test('two events never share a tag, even for the same session, because replacing a banner is silent', () => {
  assert.notEqual(describe(asking({ sessionId: 's1' })).tag, describe(item({ sessionId: 's1' })).tag)
  assert.notEqual(describe(item({ sessionId: 's1' })).tag, describe(item({ sessionId: 's2' })).tag)
})

test('a tag is the item id, which already changes whenever the state it describes changes', () => {
  assert.equal(describe(item({ id: 'waiting:s1:2026-09-01T08:00:00.000Z' })).tag, 'aivis:waiting:s1:2026-09-01T08:00:00.000Z')
})

test('a long question is clipped rather than handed to the browser whole', () => {
  const long = describe(asking({ ask: { ...asking().ask!, question: 'x'.repeat(400) } }))
  assert.ok(long.body.length < 200, `clipped, got ${long.body.length}`)
  assert.ok(long.body.endsWith('…'))
})

test('a question wrapped over several lines is flattened, because a banner has no line breaks', () => {
  const notice = describe(asking({ ask: { ...asking().ask!, question: 'which\n  branch\n\nnow?' } }))
  assert.equal(notice.body, 'which branch now?')
})

/*
 * The state machine, which used to live as two refs inside the hook and so had no tests at
 * all — while being the half of the feature where every branch that can swallow a
 * notification lives. Each sequence below is one the reader would experience as silence.
 */

/** Run a series of queues through the notifier, returning what each pass would announce. */
function sequence(
  passes: { items: AttentionItem[]; ready?: boolean; looking?: boolean; open?: string | null }[],
): string[][] {
  let state = unarmed()
  const out: string[][] = []
  for (const pass of passes) {
    const step = advance(state, pass.items, pass.ready ?? true, pass.looking ?? false, pass.open ?? null)
    state = step.state
    out.push(step.announce.map((row) => row.id))
  }
  return out
}

test('the first ready pass is a baseline, so a page load never opens with a burst of banners', () => {
  const standing = item({ id: 'waiting:s1:one' })
  assert.deepEqual(sequence([{ items: [standing] }]), [[]])
})

test('what arrives after the baseline is announced', () => {
  const first = item({ id: 'waiting:s1:one' })
  const second = item({ id: 'waiting:s1:two' })
  assert.deepEqual(sequence([{ items: [first] }, { items: [second] }]), [[], ['waiting:s1:two']])
})

test('the same queue re-read announces nothing, however many times it is pushed', () => {
  const only = item({ id: 'waiting:s1:one' })
  const second = item({ id: 'waiting:s1:two' })
  assert.deepEqual(
    sequence([{ items: [only] }, { items: [second] }, { items: [second] }, { items: [second] }]),
    [[], ['waiting:s1:two'], [], []],
  )
})

/*
 * Switching off and on again is what someone does when they suspect the feature is broken.
 * It must not leave the notifier believing it has already announced the queue it is looking
 * at — but it must not announce that standing queue either, since none of it is news.
 */
test('switching off and on takes a fresh baseline rather than a stale one', () => {
  const standing = item({ id: 'waiting:s1:one' })
  const fresh = item({ id: 'waiting:s1:two' })
  assert.deepEqual(
    sequence([
      { items: [standing] },
      { items: [standing], ready: false },
      { items: [standing] },
      { items: [fresh] },
    ]),
    [[], [], [], ['waiting:s1:two']],
  )
})

test('a queue that has not been read yet cannot arm the notifier', () => {
  // `ready` false is both "switched off" and "nothing fetched", and the second is the one
  // that matters: an empty queue taken for a baseline makes the first real answer look like
  // a fleet that just now started needing you, and announces all of it.
  const arriving = item({ id: 'waiting:s1:one' })
  assert.deepEqual(sequence([{ items: [], ready: false }, { items: [arriving] }]), [[], []])
})

test('a row on the session page you are watching is swallowed, and stays swallowed', () => {
  const mine = item({ id: 'waiting:s1:two', sessionId: 's1' })
  assert.deepEqual(
    sequence([
      { items: [item({ id: 'waiting:s1:one', sessionId: 's1' })] },
      { items: [mine], looking: true, open: 's1' },
      { items: [mine], looking: false, open: null },
    ]),
    [[], [], []],
    'announcing it later, once it is no longer new, would be worse than silence',
  )
})

test('a row for another session reaches you even while you read this one', () => {
  const other = item({ id: 'waiting:s2:one', sessionId: 's2' })
  assert.deepEqual(
    sequence([{ items: [] }, { items: [other], looking: true, open: 's1' }]),
    [[], ['waiting:s2:one']],
  )
})

test('the fleet page in front of you does not swallow anything, since a list is not read by being open', () => {
  const arriving = item({ id: 'waiting:s1:two' })
  assert.deepEqual(
    sequence([{ items: [] }, { items: [arriving], looking: true, open: null }]),
    [[], ['waiting:s1:two']],
  )
})
