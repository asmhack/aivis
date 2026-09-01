/**
 * Reading Claude Code's own record of which process is running which session.
 *
 * Everything downstream of this treats the answer as fact: a message is written to the socket
 * it names, and `end session` signals the pid it names. So the interesting cases here are not
 * the reading but the refusals — a record left behind by a session that is gone, and a record
 * whose pid the operating system has since given to something else. Believing either one
 * would aim a delivery, or a signal, at a process that has nothing to do with the session.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { forgetRegistry, readRegistry, registeredSessions, socketFor } from '../server/registry.ts'
import type { LiveProcess } from '../server/liveness.ts'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aivis-registry-'))

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

/** A moment fixed for the whole file, so `startedAt` and an elapsed column can be made to agree. */
const NOW = Date.parse('2026-09-01T12:00:00.000Z')
const now = (): number => NOW

/** One record, in the shape `~/.claude/sessions/<pid>.json` is written in. */
async function record(dir: string, entry: Record<string, unknown>): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${String(entry.pid)}.json`), JSON.stringify(entry))
}

/** A process as the scan reports one, running for `elapsed`. */
function process_(pid: number, cwd: string, elapsed: string): LiveProcess {
  return { pid, cwd, args: 'claude', elapsed }
}

test('a record is believed only about a process the scan can see', async () => {
  const dir = path.join(root, 'seen')
  await record(dir, {
    pid: 4242,
    sessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
    cwd: '/work/one',
    startedAt: NOW - 65_000,
    messagingSocketPath: '/tmp/cc-socks/4242.sock',
  })
  // The same session recorded under a pid that is not running: a session killed outright
  // leaves its file behind, and a file is not a process.
  await record(dir, {
    pid: 4243,
    sessionId: 'aaaaaaaa-0000-4000-8000-000000000002',
    cwd: '/work/one',
    startedAt: NOW - 65_000,
  })
  forgetRegistry()

  const found = await registeredSessions([process_(4242, '/work/one', '01:05')], now, dir)
  assert.deepEqual([...found.keys()], ['aaaaaaaa-0000-4000-8000-000000000001'])
  assert.equal(found.get('aaaaaaaa-0000-4000-8000-000000000001')?.pid, 4242)
})

test('a pid the operating system has recycled is not the process that was recorded', async () => {
  const dir = path.join(root, 'recycled')
  await record(dir, {
    pid: 77,
    sessionId: 'bbbbbbbb-0000-4000-8000-000000000001',
    cwd: '/work/two',
    // Recorded for a process that started an hour ago.
    startedAt: NOW - 3600_000,
  })
  forgetRegistry()

  // What is running under pid 77 now started a minute ago, so it is something else wearing
  // the number. Believing the record here would deliver a message, or a SIGTERM, to it.
  const recycled = await registeredSessions([process_(77, '/work/two', '01:00')], now, dir)
  assert.equal(recycled.size, 0)

  // The same record against the process it was actually written for.
  const same = await registeredSessions([process_(77, '/work/two', '1:00:02')], now, dir)
  assert.equal(same.size, 1)
})

test('a record with no start time is taken on its pid, since the check cannot run', async () => {
  const dir = path.join(root, 'undated')
  await record(dir, { pid: 91, sessionId: 'cccccccc-0000-4000-8000-000000000001', cwd: '/work/three' })
  forgetRegistry()
  const found = await registeredSessions([process_(91, '/work/three', '09-04:03:55')], now, dir)
  assert.equal(found.get('cccccccc-0000-4000-8000-000000000001')?.pid, 91)
})

test('junk in the directory is skipped rather than failing the reading', async () => {
  const dir = path.join(root, 'junk')
  await fs.mkdir(dir, { recursive: true })
  // Half-written JSON, a record naming no session, and a key file of the kind the client
  // keeps beside its records. This is one process reading another's bookkeeping, so all
  // three are ordinary things to meet.
  await fs.writeFile(path.join(dir, '1.json'), '{"pid":1,')
  await fs.writeFile(path.join(dir, '2.json'), JSON.stringify({ pid: 2, cwd: '/work' }))
  await fs.writeFile(path.join(dir, '3.abcdef.key'), 'not json at all')
  await record(dir, { pid: 4, sessionId: 'dddddddd-0000-4000-8000-000000000001', cwd: '/work/four' })
  forgetRegistry()

  assert.deepEqual(
    (await readRegistry(dir)).map((entry) => entry.pid),
    [4],
  )
})

test('a directory that is not there reads as no records rather than as a failure', async () => {
  forgetRegistry()
  assert.deepEqual(await readRegistry(path.join(root, 'nothing-here')), [])
})

test('the socket path comes from the record, and is derived when there is none', async () => {
  const dir = path.join(root, 'sockets')
  await record(dir, {
    pid: 500,
    sessionId: 'eeeeeeee-0000-4000-8000-000000000001',
    cwd: '/work/five',
    // Not the path aivis would derive: a shared `/tmp` carries the user id beside it.
    messagingSocketPath: '/tmp/cc-socks-501/500.sock',
  })
  forgetRegistry()
  assert.equal(await socketFor(500, dir), '/tmp/cc-socks-501/500.sock')
  assert.equal(await socketFor(501, dir), '/tmp/cc-socks/501.sock')
})
