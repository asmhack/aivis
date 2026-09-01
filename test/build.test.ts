/**
 * The one check that tells a version mismatch from an ordinary bug.
 *
 * `dist` is served off disk, so `npm run build` swaps the front end under a server that
 * carries on running the code it started with. The page then reads a field the server does
 * not send and throws — an error that names a property of undefined and nothing about the
 * rebuild that caused it. What is tested here is the comparison the page relies on to say
 * so instead: that a rebuild since start-up is noticed, that an untouched build is not
 * reported as one, and that the route answers JSON rather than falling through to the
 * static handler, which is how a server too old to know the route replies.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { clientBuildId, compareBuild } from '../server/build.ts'
import { handleRequest } from '../server/index.ts'
import { agreementFrom } from '../web/useBuild.ts'

/** A `dist` with an `index.html` in it, cleaned up by the caller. */
async function dist(html: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aivis-build-'))
  await fs.writeFile(path.join(dir, 'index.html'), html)
  return dir
}

test('a rebuilt front end reads as a different build, and an untouched one as the same', async () => {
  const dir = await dist('<script src="/assets/index-aaaaaaaa.js"></script>')
  try {
    const first = await clientBuildId(dir)
    assert.equal(typeof first, 'string')
    assert.equal(await clientBuildId(dir), first, 'reading twice must not move the fingerprint')

    // What `npm run build` does to this file: the asset names it points at are content
    // hashes, so any change to the front end lands here even though the markup around them
    // is the same.
    await fs.writeFile(path.join(dir, 'index.html'), '<script src="/assets/index-bbbbbbbb.js"></script>')
    assert.notEqual(await clientBuildId(dir), first)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a directory with no build in it has no fingerprint rather than a throw', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aivis-build-'))
  try {
    assert.equal(await clientBuildId(path.join(dir, 'dist')), null)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('the mismatch is reported only when this server is the one serving the page', () => {
  // `npm run dev`: Vite serves the front end and reloads it on its own, and this server
  // answers only the API. There is nothing here to disagree with.
  assert.deepEqual(compareBuild(false, 'aaaa', 'bbbb'), { serving: false, stale: false })
  assert.deepEqual(compareBuild(true, 'aaaa', 'aaaa'), { serving: true, stale: false })
  assert.deepEqual(compareBuild(true, 'aaaa', 'bbbb'), { serving: true, stale: true })
  // Booted with no `dist` and now handing one out: a build this process has never agreed
  // with, which is the same disagreement arrived at from the other side.
  assert.deepEqual(compareBuild(true, null, 'bbbb'), { serving: true, stale: true })
  // A build that has been removed since start-up leaves nothing to compare, and the page
  // being read came from the one this server booted with.
  assert.deepEqual(compareBuild(true, 'aaaa', null), { serving: true, stale: false })
})

/**
 * The reply the page has to be able to tell apart from a stale server's.
 *
 * An unknown `/api` path is not a 404 here: it falls through to the static handler, which
 * answers `dist/index.html` with a 200. That is exactly what a server started before this
 * route existed sends back, and the client reads a non-JSON answer as the mismatch itself
 * — so this route has to be dispatched above that fallthrough and answer JSON.
 */
test('the build route answers JSON rather than falling through to the page', async () => {
  const answer: { status: number; headers: Record<string, string>; body: string } = {
    status: 0,
    headers: {},
    body: '',
  }
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader(name: string, value: string) {
      answer.headers[name.toLowerCase()] = value
    },
    writeHead(status: number, headers?: Record<string, string | number>) {
      answer.status = status
      for (const [name, value] of Object.entries(headers ?? {})) {
        answer.headers[name.toLowerCase()] = String(value)
      }
      ;(this as { headersSent: boolean }).headersSent = true
      return this
    },
    end(body?: string | Buffer) {
      if (body !== undefined) answer.body += typeof body === 'string' ? body : body.toString('utf8')
      ;(this as { writableEnded: boolean }).writableEnded = true
      return this
    },
  } as unknown as ServerResponse
  const req = {
    method: 'GET',
    url: '/api/build',
    headers: { host: '127.0.0.1:4319' },
  } as unknown as IncomingMessage

  await handleRequest(req, res)
  assert.equal(answer.status, 200)
  assert.match(answer.headers['content-type'] ?? '', /application\/json/)
  const body = JSON.parse(answer.body) as { serving: boolean; stale: boolean }
  assert.equal(typeof body.serving, 'boolean')
  assert.equal(typeof body.stale, 'boolean')
})

/**
 * How the page reads the reply, including the reply it gets from the servers this was
 * written for.
 *
 * The mismatch that started this was a server months older than the page it was serving,
 * and such a server has no `/api/build` to answer with. It does not 404 either: an unknown
 * `/api` path falls through to the static handler and comes back as `index.html` with a
 * 200. Reading that as agreement would leave the notice silent in exactly the case it
 * exists for, so it counts as the mismatch itself.
 */
test('a reply that is not the answer counts as the mismatch, which is what an old server sends', async () => {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  assert.equal(await agreementFrom(json({ serving: true, stale: false })), 'ok')
  assert.equal(await agreementFrom(json({ serving: false, stale: false })), 'ok')
  assert.equal(await agreementFrom(json({ serving: true, stale: true })), 'stale')

  const page = new Response('<!doctype html><html></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
  assert.equal(await agreementFrom(page), 'stale', 'the static fallthrough is an old server')

  const refused = new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } })
  assert.equal(await agreementFrom(refused), 'stale')

  const broken = new Response('{ not json', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(await agreementFrom(broken), 'stale')

  // No reply at all is a server that is down, which the socket's own badge already says.
  assert.equal(await agreementFrom(null), 'unknown')
})
