/**
 * What `server/transcriptView.ts` remembers between requests, and what it refuses to.
 *
 * A conversation page asks for one image at a time as it paints, and each of those
 * requests walks the same transcript looking for a single record. Two things keep that
 * affordable: the walks are handed out a couple at a time, and a walk that found something
 * is not repeated. Both are invisible from the outside — nothing in the response says
 * whether it came from a scan or from memory — so the assertions here reach for the one
 * observable difference, which is that a remembered answer survives the file changing
 * underneath it while a forgotten one does not.
 *
 * The fixtures are `.jsonl` files shaped like what Claude Code writes: one JSON record per
 * line, an image inlined as base64 inside a user record's content blocks.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readImage, transcriptMentions } from '../server/transcriptView.ts'

const tempDirs: string[] = []

after(async () => {
  for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true })
})

const UUID = 'b8e04d71-0000-4000-8000-000000000001'
const PIXEL = Buffer.from('not really a png, but it round-trips')

async function newTranscript(body: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aivis-view-'))
  tempDirs.push(dir)
  const file = path.join(dir, 'session.jsonl')
  await fs.writeFile(file, body)
  return file
}

/** A user turn carrying one screenshot, which is how an image reaches a transcript. */
function imageRecord(uuid: string): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: PIXEL.toString('base64') },
        },
      ],
    },
  })
}

/** Filler that pushes earlier records out of a narrow tail window. */
function padding(lines: number): string {
  return Array.from({ length: lines }, (_, i) =>
    JSON.stringify({ type: 'assistant', uuid: `pad-${i}`, message: { role: 'assistant', content: [] } }),
  ).join('\n')
}

const WHOLE_FILE = 64 * 1024 * 1024

test('an image is read back out of the record that carries it', async () => {
  const file = await newTranscript(`${imageRecord(UUID)}\n`)
  const image = await readImage(file, UUID, 1, WHOLE_FILE)
  assert.equal(image?.mediaType, 'image/png')
  assert.equal(image?.bytes.toString(), PIXEL.toString())
})

test('a record with no image at that index is not an image', async () => {
  const file = await newTranscript(`${imageRecord(UUID)}\n`)
  assert.equal(await readImage(file, UUID, 0, WHOLE_FILE), null)
})

test('an image already found is served without reading the file again', async () => {
  const file = await newTranscript(`${imageRecord(UUID)}\n`)
  assert.ok(await readImage(file, UUID, 1, WHOLE_FILE))
  // Emptying the file is not something a transcript does — it is only appended to — but it
  // is the one way to prove from outside that the second answer never touched the disk.
  await fs.writeFile(file, '')
  const again = await readImage(file, UUID, 1, WHOLE_FILE)
  assert.equal(again?.bytes.toString(), PIXEL.toString())
})

test('an image that was not found is looked for again in a wider window', async () => {
  const file = await newTranscript(`${imageRecord(UUID)}\n${padding(40)}\n`)
  // A window this narrow opens well past the record, so the first look cannot find it.
  assert.equal(await readImage(file, UUID, 1, 200), null)
  // If that miss had been remembered, the record would stay invisible to every later
  // request even though it is right there in the file.
  const found = await readImage(file, UUID, 1, WHOLE_FILE)
  assert.equal(found?.bytes.toString(), PIXEL.toString())
})

test('a path is only mentioned once the transcript says so, and stays mentioned after', async () => {
  const target = '/tmp/aivis-test/shot.png'
  const file = await newTranscript(`${imageRecord(UUID)}\n`)
  // Not yet written about, so the localfile route would refuse it — and the refusal is not
  // remembered, because the very next turn may name the file.
  assert.equal(await transcriptMentions(file, target, WHOLE_FILE), false)
  const mention = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `see ${target}` }] },
  }
  await fs.appendFile(file, `${JSON.stringify(mention)}\n`)
  assert.equal(await transcriptMentions(file, target, WHOLE_FILE), true)
  // A mention cannot be taken back by a file that is only appended to, so the answer is
  // allowed to outlive a rewrite of it.
  await fs.writeFile(file, '')
  assert.equal(await transcriptMentions(file, target, WHOLE_FILE), true)
})

test('a burst of scans all finish, and one that throws still hands its slot on', async () => {
  const file = await newTranscript(`${imageRecord(UUID)}\n${padding(200)}\n`)
  const missing = path.join(path.dirname(file), 'not-here.jsonl')
  // Every one of these fails on the open, which is the case that would leak a slot: six
  // failures against a gate two wide would leave nothing for the reads that follow, and
  // this test would hang rather than fail.
  const failures = await Promise.allSettled(
    Array.from({ length: 6 }, () => readImage(missing, UUID, 1, WHOLE_FILE)),
  )
  assert.ok(failures.every((result) => result.status === 'rejected'))

  const images = await Promise.all(
    Array.from({ length: 8 }, () => readImage(file, UUID, 1, WHOLE_FILE)),
  )
  assert.ok(images.every((image) => image?.bytes.toString() === PIXEL.toString()))
})
