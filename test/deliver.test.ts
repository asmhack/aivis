import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  deliverToSession,
  materialize,
  prepareAttachmentDir,
  sweepAttachments,
} from '../server/deliver.ts'

/*
 * The attachment directory is the one place aivis writes a user's pasted screenshots to disk
 * and the one place it deletes recursively, and on Linux it sits at a fixed path under the
 * `/tmp` every account on the machine shares. An attacker who gets there first — planting a
 * symlink aimed at a directory of ours, or a world-writable directory of their own — turns
 * that sweep into a delete-my-files primitive. `prepareAttachmentDir` is the check that
 * refuses to touch anything it cannot prove is ours, so the refusals below are the guarantee:
 * a refactor that goes back to `mkdir(recursive: true)`, or that follows a symlink, fails here.
 *
 * Every test points the code at its own `mkdtemp` scratch root, which is what the optional
 * `root` parameter exists for. Nothing here touches the real /tmp/aivis-attachments.
 */

/** A scratch directory the test owns outright, removed when the test ends. */
async function scratch(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aivis-deliver-test-'))
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  return dir
}

/** One pixel of PNG, enough to have bytes worth writing. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('a missing attachment directory is created private to this account', async (t) => {
  const base = await scratch(t)
  const root = path.join(base, 'attachments')
  assert.equal(await prepareAttachmentDir(root), root)
  const stat = await fs.lstat(root)
  assert.equal(stat.isDirectory(), true)
  // Group and other bits must be off: the point of the directory is that only we can read it.
  assert.equal(stat.mode & 0o077, 0)
})

/*
 * The attack the check exists for. `mkdir(recursive: true)` is a silent no-op on a path that
 * already exists, so a symlink planted at the predictable name used to be adopted wholesale —
 * attachments written into the attacker's chosen directory, and `sweepAttachments` recursing
 * into it. `lstat` sees the link rather than the directory it points at, so this refuses.
 */
test('a symlinked attachment directory is refused, and its target is left alone', async (t) => {
  const base = await scratch(t)
  const victim = path.join(base, 'victim')
  await fs.mkdir(victim, { mode: 0o700 })
  const treasure = path.join(victim, 'notes.txt')
  await fs.writeFile(treasure, 'still here')
  const root = path.join(base, 'attachments')
  await fs.symlink(victim, root)

  await assert.rejects(prepareAttachmentDir(root), /is not a plain directory/)
  // Refusing has to mean nothing at all happened inside the target, not merely no new files.
  assert.deepEqual(await fs.readdir(victim), ['notes.txt'])
  assert.equal(await fs.readFile(treasure, 'utf8'), 'still here')
  // And the link itself is left as found rather than replaced with a directory of ours.
  assert.equal((await fs.lstat(root)).isSymbolicLink(), true)
})

test('a plain file where the attachment directory belongs is refused', async (t) => {
  const base = await scratch(t)
  const root = path.join(base, 'attachments')
  await fs.writeFile(root, 'not a directory')
  await assert.rejects(prepareAttachmentDir(root), /is not a plain directory/)
})

/*
 * A directory that is genuinely ours but readable by the world is a different case from one
 * belonging to somebody else: nothing but this account could have widened it, so tightening it
 * is enough and refusing would only break a user whose umask surprised them.
 */
test('a loose mode on a directory we own is tightened rather than refused', async (t) => {
  const base = await scratch(t)
  const root = path.join(base, 'attachments')
  await fs.mkdir(root)
  await fs.chmod(root, 0o755)
  assert.equal(await prepareAttachmentDir(root), root)
  assert.equal((await fs.lstat(root)).mode & 0o077, 0)
})

/*
 * The foreign-owner branch has no test because a test cannot create a directory owned by
 * another user without being root, and an audit suite that wants root is a worse problem than
 * the one it checks. The uid comparison it rests on is a single `stat.uid !== process.getuid()`
 * immediately below the symlink check that is covered above.
 */

test('attachments land in a fresh private directory with private bytes', async (t) => {
  const base = await scratch(t)
  const root = path.join(base, 'attachments')
  const written = await materialize(
    [{ mediaType: 'image/png', data: PIXEL, name: 'screenshot.png' }],
    'abc-123',
    root,
  )
  assert.equal(written.length, 1)
  const file = written[0]!
  assert.equal(path.basename(file), 'screenshot.png')
  // The per-message directory is a mkdtemp sibling of the root, never the root itself.
  assert.equal(path.dirname(path.dirname(file)), root)
  assert.match(path.basename(path.dirname(file)), /^abc-123-/)
  assert.equal((await fs.lstat(path.dirname(file))).mode & 0o077, 0)
  // A pasted screenshot is as private as the conversation it came from.
  assert.equal((await fs.lstat(file)).mode & 0o077, 0)
  assert.equal((await fs.readFile(file)).length > 0, true)
})

/*
 * The filename arrives from the browser, so it is attacker-shaped input: a traversal, a name
 * that reduces to a directory, or one made entirely of characters the filter strips must all
 * end up as a generated name inside the message's own directory.
 */
test('a hostile attachment name cannot escape the message directory', async (t) => {
  const base = await scratch(t)
  const root = path.join(base, 'attachments')
  const written = await materialize(
    [
      { mediaType: 'image/png', data: PIXEL, name: '../../escape.png' },
      { mediaType: 'image/png', data: PIXEL, name: '..' },
      { mediaType: 'image/jpeg', data: PIXEL, name: '/////' },
    ],
    'hostile',
    root,
  )
  const dir = path.dirname(written[0]!)
  for (const file of written) {
    assert.equal(path.dirname(file), dir)
  }
  assert.equal(path.basename(written[0]!), 'escape.png')
  assert.equal(path.basename(written[1]!), 'image-2.png')
  assert.equal(path.basename(written[2]!), 'image-3.jpeg')
})

test('a refused directory means nothing is written anywhere', async (t) => {
  const base = await scratch(t)
  const victim = path.join(base, 'victim')
  await fs.mkdir(victim, { mode: 0o700 })
  const root = path.join(base, 'attachments')
  await fs.symlink(victim, root)
  await assert.rejects(
    materialize([{ mediaType: 'image/png', data: PIXEL, name: 'a.png' }], 'id', root),
    /is not a plain directory/,
  )
  assert.deepEqual(await fs.readdir(victim), [])
})

/** Old enough to be swept: the cutoff is a day, this is two. */
const STALE = new Date(Date.now() - 48 * 3600_000)

test('the sweep removes stale message directories and leaves fresh ones', async (t) => {
  const root = await scratch(t)
  const old = path.join(root, 'old')
  const recent = path.join(root, 'recent')
  await fs.mkdir(old)
  await fs.writeFile(path.join(old, 'image.png'), 'bytes')
  await fs.mkdir(recent)
  await fs.utimes(old, STALE, STALE)

  await sweepAttachments(root)
  assert.deepEqual(await fs.readdir(root), ['recent'])
})

/*
 * The destructive half of the original finding. A stale entry that is a symlink must be
 * unlinked as the link it is; recursing through it would delete whatever it points at, which
 * is exactly the primitive an attacker who can create entries under a shared /tmp would want.
 */
test('the sweep unlinks a stale symlink without following it', async (t) => {
  const base = await scratch(t)
  const root = path.join(base, 'attachments')
  await fs.mkdir(root, { mode: 0o700 })
  const victim = path.join(base, 'victim')
  await fs.mkdir(victim, { mode: 0o700 })
  await fs.writeFile(path.join(victim, 'notes.txt'), 'still here')

  const link = path.join(root, 'stale')
  await fs.symlink(victim, link)
  // lutimes ages the link itself; utimes would age the directory it points at instead.
  await fs.lutimes(link, STALE, STALE)

  await sweepAttachments(root)
  assert.deepEqual(await fs.readdir(root), [])
  assert.deepEqual(await fs.readdir(victim), ['notes.txt'])
})

test('the sweep does nothing at all when the directory is not there', async (t) => {
  const base = await scratch(t)
  await sweepAttachments(path.join(base, 'never-created'))
})

/*
 * `error` on the outcome is reserved for deliveries aivis itself declined, so that the caller
 * can say why instead of blaming an unreachable session. A socket that simply is not there is
 * not one of those: it is the ordinary "that pid is gone" case, and it carries no reason.
 * The pid below is above the system maximum, so no socket for it can exist and nothing is
 * connected to, signalled, or started.
 */
test('an absent socket is a plain failure with no reason attached', async () => {
  const outcome = await deliverToSession(2 ** 30, 'hello')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error, undefined)
  assert.deepEqual(outcome.attachments, [])
  assert.match(outcome.uuid, /^[0-9a-f-]{36}$/)
})
