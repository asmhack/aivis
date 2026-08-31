/**
 * Tests for the two rules the fleet socket folds driver statuses with.
 *
 * Both exist because of the same failure: a DriverStatus that outlives the driver leaves a
 * page offering controls — an answer card, a stop button, a queue count — for a process the
 * server no longer has, and every one of those clicks comes back as an error. The rules are
 * pulled out of the hook so they can be checked here; the socket wiring around them needs a
 * browser, but the decisions do not.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyDriverStatus, dropUnconfirmed } from '../web/useFleet.ts'
import type { DriverState, DriverStatus } from '../shared/types.ts'

const status = (sessionId: string, state: DriverState): DriverStatus => ({
  sessionId,
  state,
  detail: state === 'error' ? 'signal SIGTERM' : null,
  queued: 0,
  permissionMode: 'default',
  asks: [],
})

const mapOf = (...entries: DriverStatus[]): Map<string, DriverStatus> =>
  new Map(entries.map((entry) => [entry.sessionId, entry]))

test('a status replaces whatever was known about that session', () => {
  const before = mapOf(status('a', 'idle'))
  const after = applyDriverStatus(before, status('a', 'working'))
  assert.equal(after.get('a')?.state, 'working')
  assert.equal(before.get('a')?.state, 'idle', 'the map handed in is not mutated')
})

test('a driver that exited cleanly is dropped, because the server has already dropped it', () => {
  const after = applyDriverStatus(mapOf(status('a', 'working')), status('a', 'exited'))
  assert.equal(after.has('a'), false)
})

test('a driver that died with an error is kept, because its detail is the only account of why', () => {
  const after = applyDriverStatus(mapOf(status('a', 'working')), status('a', 'error'))
  assert.equal(after.get('a')?.state, 'error')
  assert.equal(after.get('a')?.detail, 'signal SIGTERM')
})

test('a snapshot sweep keeps only the drivers the server mentioned again', () => {
  // What a restarted daemon looks like from here: session b was being driven before, and
  // the process that came back says nothing about it, so nothing about it is still true.
  const before = mapOf(status('a', 'working'), status('b', 'working'))
  const after = dropUnconfirmed(before, new Set(['a']))
  assert.deepEqual([...after.keys()], ['a'])
})

test('a sweep that finds nothing stale hands back the same map, so nothing re-renders', () => {
  const before = mapOf(status('a', 'working'))
  assert.equal(dropUnconfirmed(before, new Set(['a'])), before)
  const empty = new Map<string, DriverStatus>()
  assert.equal(dropUnconfirmed(empty, new Set()), empty)
})

test('a driver that died and was never mentioned again goes on the next snapshot', () => {
  // The error entry is deliberately kept while the connection lasts, but it must not
  // survive a reconnect: by then the state on screen would be a memory of another process.
  const dead = applyDriverStatus(mapOf(status('a', 'working')), status('a', 'error'))
  assert.equal(dropUnconfirmed(dead, new Set()).size, 0)
})
