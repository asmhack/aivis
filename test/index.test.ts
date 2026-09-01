/**
 * The request boundary, driven rather than described.
 *
 * Everything here guards something that has no second line of defence: the origin gate is
 * the only thing between a page you happen to have open and routes that start `claude` and
 * hand back every prompt in every transcript; the media-type gate is what keeps a
 * cross-site POST from staying a CORS "simple request"; the percent-decoding is what keeps
 * one malformed URL from ending a daemon that is driving live sessions. Those checks used
 * to be reachable only by reading this file's own source text, which passes just as
 * happily when the check has been commented out or a route has been hoisted above it, so
 * `server/index.ts` now guards its start-up behind `isEntrypoint()` and the tests below
 * send real requests through the real handler and the real WebSocket options instead.
 *
 * Nothing here binds a port or spawns anything: the handler is called directly with a fake
 * request and a response that records what it was told to write.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  answerRequest,
  drivers,
  fleet,
  handleRequest,
  inertFileHeaders,
  resumeCommand,
  wss,
} from '../server/index.ts'
import { pendingRunId } from '../shared/bash.ts'
import type { Session } from '../shared/types.ts'

const tempDirs: string[] = []

after(async () => {
  for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true })
})

/** What the handler ended up writing, which is the whole of what a client would see. */
interface Answer {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * A response that records instead of writing.
 *
 * `json` reaches for `writeHead` and `end`, the framing headers arrive through
 * `setHeader`, and the 500 wrapper reads `headersSent` and `writableEnded` to decide
 * whether it may still answer — so those are what this has to be honest about.
 */
function recorder(): { res: ServerResponse; answer: Answer } {
  const answer: Answer = { status: 0, headers: {}, body: '' }
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
      if (body !== undefined) answer.body += typeof body === 'string' ? body : body.toString('binary')
      ;(this as { writableEnded: boolean }).writableEnded = true
      return this
    },
  }
  return { res: res as unknown as ServerResponse, answer }
}

/** A request as the handler reads one: a method, a URL still percent-encoded, and headers. */
function request(init: { method?: string; url: string; headers?: Record<string, string> }): IncomingMessage {
  return {
    method: init.method ?? 'GET',
    url: init.url,
    headers: { host: '127.0.0.1:4319', ...init.headers },
  } as unknown as IncomingMessage
}

/**
 * A request carrying a JSON body.
 *
 * `readBody` reads with `for await (const chunk of req)`, so the fake has to be async
 * iterable rather than merely have a `body` property on it.
 */
function jsonRequest(init: { method: string; url: string; body: unknown }): IncomingMessage {
  const payload = Buffer.from(JSON.stringify(init.body))
  return {
    method: init.method,
    url: init.url,
    headers: { host: '127.0.0.1:4319', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield payload
    },
  } as unknown as IncomingMessage
}

async function sendJson(init: { method: string; url: string; body: unknown }): Promise<Answer> {
  const { res, answer } = recorder()
  await handleRequest(jsonRequest(init), res)
  return answer
}

/** Send one request through the real handler and read back what it answered. */
async function send(init: { method?: string; url: string; headers?: Record<string, string> }): Promise<Answer> {
  const { res, answer } = recorder()
  await handleRequest(request(init), res)
  return answer
}

/**
 * Put a session in front of the routes without scanning the store.
 *
 * A real scan reads every transcript on the machine, spawns `git`, and lists processes —
 * none of which says anything about the boundary being tested here. The fleet's map is
 * private, so this reaches into it the way `test/driver.test.ts` reaches into a driver's:
 * the point is to hand `fleet.get(id)` the one session a route is about to look up.
 */
function seed(session: Pick<Session, 'id' | 'cwd' | 'transcriptPath'>): void {
  const sessions = (fleet as unknown as { sessions: Map<string, unknown> }).sessions
  sessions.set(session.id, session)
}

function forget(id: string): void {
  ;(fleet as unknown as { sessions: Map<string, unknown> }).sessions.delete(id)
}

/** Write a transcript and hand back its path, so a route has a real file to read. */
async function transcript(rows: unknown[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aivis-index-'))
  tempDirs.push(dir)
  const file = path.join(dir, 'b8e04d71-0000-4000-8000-000000000001.jsonl')
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  return file
}

/*
 * The gate has to be the first thing that happens, not merely present somewhere in the
 * file. A route dispatched above it — an early `return` added while refactoring, a health
 * check hoisted for convenience — is exactly the drift that reopens C-001, and it is
 * invisible to any test that only asks whether the call appears in the source.
 */
test('a page on another site is refused before any route runs', async () => {
  for (const origin of ['http://evil.com', 'null']) {
    for (const url of ['/api/health', '/api/sessions', '/api/attention', '/api/drivers']) {
      const answer = await send({ url, headers: { origin } })
      assert.equal(answer.status, 403, `${url} answered ${answer.status} to Origin: ${origin}`)
      assert.match(answer.body, /did not come from a page aivis is served on/)
    }
  }
  // And the same route answers normally when nothing is wrong with the request, so the
  // assertions above are about the origin rather than about a handler that refuses
  // everything.
  const allowed = await send({ url: '/api/health', headers: { origin: 'http://127.0.0.1:4319' } })
  assert.equal(allowed.status, 200)
})

/*
 * Framing is the one browser reach the origin gate cannot see: loading a document into an
 * iframe is a GET navigation that carries no `Origin`, so it takes the "no Origin, allow
 * it" path and the dashboard is served into the attacker's page. They cannot read it, but
 * they can put their own bait under a transparent copy of it and collect a click on a
 * permission prompt. The refusal has to be a response header — a `frame-ancestors` in a
 * `<meta>` is ignored — and it has to be set before the first early return, so that even
 * the answers that refuse the request carry it.
 */
test('every answer refuses to be framed, including the ones that refuse the request', async () => {
  const cases: Record<string, string>[] = [{}, { origin: 'http://evil.com' }]
  for (const headers of cases) {
    const answer = await send({ url: '/api/health', headers })
    assert.equal(answer.headers['x-frame-options'], 'DENY')
    assert.equal(answer.headers['content-security-policy'], `frame-ancestors 'none'`)
  }
})

/*
 * A handshake is not covered by the same-origin policy at all, and the first frame this
 * socket sends is the whole fleet — every title, which is your prompts, every cwd and every
 * transcript path. This runs the table through the very options object the running server
 * was built with, so a second `WebSocketServer`, an env-flag bypass, or a widened predicate
 * shows up here rather than in someone's browser.
 */
test('the WebSocket handshake refuses the origins the routes refuse', () => {
  const verify = wss.options.verifyClient as
    | ((info: { req: { headers: Record<string, string> } }) => boolean)
    | undefined
  assert.equal(typeof verify, 'function', 'the socket must be built with a verifyClient')
  const handshake = (headers: Record<string, string>): boolean =>
    (verify as (info: { req: { headers: Record<string, string> } }) => boolean)({ req: { headers } })

  assert.equal(handshake({ host: '127.0.0.1:4319', origin: 'null' }), false)
  assert.equal(handshake({ host: '127.0.0.1:4319', origin: 'http://evil.com' }), false)
  assert.equal(handshake({ host: '127.0.0.1:4319', origin: 'http://127.0.0.1.evil.com' }), false)
  assert.equal(handshake({ host: '127.0.0.1:4319', origin: 'http://127.0.0.1:4319' }), true)
  // A client with no Origin at all is the probe scripts in `scripts/`, not a page.
  assert.equal(handshake({ host: '127.0.0.1:4319' }), true)
})

/*
 * The media-type gate, from the outside. `/interrupt` and `/stop` read no request body, so
 * a gate that only ran inside `readBody` never ran for them — and a POST with no body sends
 * no `Content-Type`, which leaves it a simple request that needs no preflight. These two
 * are the routes that cut a turn short and SIGTERM a driven `claude`.
 */
test('a POST that does not claim JSON is refused, including on the routes that read no body', async () => {
  const routes = [
    '/api/sessions/abc/stop',
    '/api/sessions/abc/interrupt',
    '/api/sessions/abc/end',
    '/api/sessions/abc/answer',
    '/api/sessions/abc/bash',
    '/api/sessions/abc/bash/stop',
    '/api/sessions',
  ]
  for (const url of routes) {
    const types: Record<string, string>[] = [
      {},
      { 'content-type': 'text/plain' },
      { 'content-type': 'application/x-www-form-urlencoded' },
      { 'content-type': 'multipart/form-data; boundary=x' },
    ]
    for (const headers of types) {
      const answer = await send({ method: 'POST', url, headers })
      assert.equal(answer.status, 415, `${url} answered ${answer.status} to ${JSON.stringify(headers)}`)
    }
  }
})

test('a POST that does claim JSON reaches its route', async () => {
  // No driver exists for either id, which is what these two say when they get that far —
  // and neither answer is the 415 above, so the gate is what the previous test measured.
  const stop = await send({
    method: 'POST',
    url: '/api/sessions/abc/stop',
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(stop.status, 404)
  const interrupt = await send({
    method: 'POST',
    url: '/api/sessions/abc/interrupt',
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
  assert.equal(interrupt.status, 409)
})

/*
 * `new URL()` leaves a path percent-encoded, so a segment like `%E0%A4%A` reaches the route
 * matches exactly as it was sent and `decodeURIComponent` throws on it. Nothing awaits the
 * handler in production, so that throw would arrive as an unhandled rejection: one
 * malformed URL from any local page would end a daemon that is driving live sessions.
 */
test('a segment that is not valid percent-encoding is a bad request rather than a throw', async () => {
  for (const url of [
    '/api/sessions/%E0%A4%A/handoff',
    '/api/sessions/%ZZ/transcript',
    '/api/sessions/%/image?uuid=x',
    '/api/sessions/ok/agents/%ZZ/tools',
    '/api/sessions/%E0%A4%A/stop',
  ]) {
    const answer = await send({
      method: url.endsWith('/stop') ? 'POST' : 'GET',
      url,
      headers: url.endsWith('/stop') ? { 'content-type': 'application/json' } : {},
    })
    assert.equal(answer.status, 400, `${url} answered ${answer.status}`)
    assert.match(answer.body, /percent-encoding/)
  }
})

test('a segment that decodes is looked up as what it decodes to', async () => {
  seed({ id: 'abc def', cwd: '/tmp/aivis-test', transcriptPath: '/tmp/aivis-test/none.jsonl' })
  try {
    const found = await send({ url: '/api/sessions/abc%20def/handoff' })
    assert.equal(found.status, 200, 'the decoded id names the seeded session')
    // An id that decodes but names nothing is an ordinary 404, not a 400.
    const missing = await send({ url: '/api/sessions/abc%20ghi/handoff' })
    assert.equal(missing.status, 404)
  } finally {
    forget('abc def')
  }
})

/*
 * The 500 wrapper. `node:http` does not await the handler, so a rejection it leaves behind
 * would be unhandled — and this process is driving `claude` children a crash would orphan.
 * A request whose headers cannot even be read stands in for any unexpected failure.
 */
test('a request the handler cannot answer becomes a 500 rather than a crash', async () => {
  const { res, answer } = recorder()
  const broken = {
    method: 'GET',
    url: '/api/health',
    get headers(): never {
      throw new Error('no headers on this one')
    },
  } as unknown as IncomingMessage
  const logged: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(' '))
  try {
    answerRequest(broken, res)
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    console.error = original
  }
  assert.equal(answer.status, 500)
  assert.match(answer.body, /internal error/)
  assert.equal(logged.length, 1, 'the failure is reported once, on standard error')
})

/*
 * The `claude --resume` line the handoff sheet offers to copy. Neither half is aivis's own
 * string: both come out of a `.jsonl` that any local process may write. The id is refused
 * by `isPlausibleSessionId` long before it reaches here, so this states what the quoting
 * does for an id that layer would now never produce — because the quoting is what has to
 * survive somebody widening that alphabet.
 */
test('the resume command quotes both halves, so a paste stays one command', () => {
  const command = resumeCommand({
    id: `abc'; touch /tmp/aivis-never-run #`,
    cwd: `/tmp/o'ops && echo hi`,
  })
  assert.equal(
    command,
    `cd '/tmp/o'\\''ops && echo hi' && claude --resume 'abc'\\''; touch /tmp/aivis-never-run #'`,
  )
  // Every quote in either value is closed and reopened rather than ending the argument, so
  // the command line holds an even number of them and nothing escapes into shell syntax.
  assert.equal((command.match(/'/g) ?? []).length % 2, 0)
  const ordinary = resumeCommand({ id: 'b8e04d71-0000-4000-8000-000000000001', cwd: '/home/dev/my project' })
  assert.equal(ordinary, `cd '/home/dev/my project' && claude --resume 'b8e04d71-0000-4000-8000-000000000001'`)
})

test('the handoff route hands back the quoted command rather than a raw one', async () => {
  seed({
    id: 'b8e04d71-0000-4000-8000-000000000001',
    cwd: `/tmp/o'ops`,
    transcriptPath: '/tmp/none.jsonl',
  })
  try {
    const answer = await send({ url: '/api/sessions/b8e04d71-0000-4000-8000-000000000001/handoff' })
    assert.equal(answer.status, 200)
    const body = JSON.parse(answer.body) as { command: string }
    assert.equal(
      body.command,
      `cd '/tmp/o'\\''ops' && claude --resume 'b8e04d71-0000-4000-8000-000000000001'`,
    )
  } finally {
    forget('b8e04d71-0000-4000-8000-000000000001')
  }
})

/*
 * An image route serves bytes aivis did not write. A `.jsonl` another local process dropped
 * into the store can call its base64 `text/html`, and the conversation view renders every
 * image as a link that opens at the top level — so serving that back would put a page of
 * somebody else's writing in aivis's own origin, where the API asks for no credential.
 */
test('a transcript image is served only as a type Claude itself accepts', async () => {
  const file = await transcript([
    {
      uuid: 'evil-0000',
      timestamp: new Date().toISOString(),
      message: {
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'text/html',
              data: Buffer.from('<script>fetch("/api/sessions")</script>').toString('base64'),
            },
          },
        ],
      },
    },
    {
      uuid: 'fine-0000',
      timestamp: new Date().toISOString(),
      message: {
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: Buffer.from('not really a png').toString('base64') },
          },
        ],
      },
    },
  ])
  seed({ id: 'imaged', cwd: '/tmp', transcriptPath: file })
  try {
    const refused = await send({ url: '/api/sessions/imaged/image?uuid=evil-0000&index=0' })
    assert.equal(refused.status, 415)
    assert.doesNotMatch(refused.body, /<script>/, 'the bytes are not served, and neither is the type echoed back')

    const served = await send({ url: '/api/sessions/imaged/image?uuid=fine-0000&index=0' })
    assert.equal(served.status, 200)
    assert.equal(served.headers['content-type'], 'image/png')
    // Even for an accepted type the response has to say it is not a document: `nosniff`
    // stops a sniffed type from promoting it, and the sandbox drops it into an opaque
    // origin with scripts off.
    assert.equal(served.headers['x-content-type-options'], 'nosniff')
    assert.match(served.headers['content-security-policy'] ?? '', /sandbox/)
  } finally {
    forget('imaged')
  }
})

/*
 * The headers themselves, stated once. A filename reaches this out of a query string or off
 * disk, so it may hold a quote or a newline — either of which would end the header value
 * and start a new header.
 */
test('a file served out of a session is marked as not being a document', () => {
  const headers = inertFileHeaders('shot.png')
  assert.equal(headers['X-Content-Type-Options'], 'nosniff')
  assert.match(headers['Content-Security-Policy'] ?? '', /sandbox/)
  assert.match(headers['Content-Security-Policy'] ?? '', /default-src 'none'/)
  // A policy passed to `writeHead` replaces the blanket one set on every response, so the
  // framing refusal has to be repeated here or these routes become the framable ones.
  assert.match(headers['Content-Security-Policy'] ?? '', /frame-ancestors 'none'/)
  assert.equal(headers['Content-Disposition'], 'inline; filename="shot.png"')

  const hostile = inertFileHeaders('a"\r\nSet-Cookie: x=1\r\n.png')
  assert.equal(hostile['Content-Disposition'], 'inline; filename="a---Set-Cookie--x-1--.png"')
  const name = /^inline; filename="([^]*)"$/.exec(hostile['Content-Disposition'] ?? '')?.[1] ?? ''
  assert.doesNotMatch(name, /["\r\n]/, 'nothing in the name can close the value or start a header')
  // A name that scrubs away to nothing still has to leave a well-formed header.
  assert.equal(inertFileHeaders('')['Content-Disposition'], 'inline; filename="image"')
})

/*
 * A `!` bash line, end to end through the routes it actually travels.
 *
 * The pieces are unit-tested next door; what is only reachable here is the wiring, which is
 * where a run gets lost. Three things have to hold together: the run is held rather than
 * sent, the conversation shows it while it is held although no transcript contains it, and
 * the next message carries it and empties the queue. Any one of them silently failing turns
 * a command you watched run into context the session never saw.
 */
test('a `!` line runs, is shown while it waits, and travels with the next message', async () => {
  const file = await transcript([
    {
      type: 'user',
      uuid: 'b8e04d71-0000-4000-8000-000000000009',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    },
  ])
  const id = 'b8e04d71-0000-4000-8000-000000000001'
  seed({ id, cwd: os.tmpdir(), transcriptPath: file })

  // A driver has to exist for the message route to take the path that does not spawn
  // anything. It records what it was handed, which is the assertion.
  const handed: string[] = []
  const registry = drivers as unknown as { drivers: Map<string, unknown> }
  registry.drivers.set(id, {
    alive: true,
    status: { sessionId: id, state: 'idle', asks: [] },
    send(text: string) {
      handed.push(text)
      return true
    },
  })

  try {
    const ran = await sendJson({
      method: 'POST',
      url: `/api/sessions/${id}/bash`,
      body: { command: 'echo held' },
    })
    assert.equal(ran.status, 202, ran.body)

    // Nothing was sent to the session: a `!` line is not a message, and this is the property
    // that lets it run while the session is mid-turn.
    assert.deepEqual(handed, [])

    // The run is in no transcript — aivis cannot write to one — so the conversation has to
    // get it from the daemon or it is invisible until it is sent.
    let shown: { entries: { kind: string; command?: string; pending?: boolean; running?: boolean }[] } = {
      entries: [],
    }
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const page = await send({ url: `/api/sessions/${id}/transcript` })
      shown = JSON.parse(page.body)
      if (shown.entries.some((entry) => entry.kind === 'bash' && !entry.running)) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const run = shown.entries.find((entry) => entry.kind === 'bash')
    assert.equal(run?.command, 'echo held')
    assert.equal(run?.pending, true, 'held by the daemon rather than recorded')

    const sent = await sendJson({
      method: 'POST',
      url: `/api/sessions/${id}/message`,
      body: { text: 'what did that print?' },
    })
    assert.equal(sent.status, 202, sent.body)
    assert.equal(handed.length, 1)
    // The run goes in front of the message, in the shape a terminal would have recorded it,
    // and the message is still there behind it.
    assert.match(handed[0] ?? '', /^<bash-input>echo held<\/bash-input>/)
    assert.match(handed[0] ?? '', /<bash-stdout>held\n<\/bash-stdout>/)
    assert.match(handed[0] ?? '', /what did that print\?$/)

    // And it is gone afterwards, so the next message does not carry it a second time.
    const after = JSON.parse((await send({ url: `/api/sessions/${id}/transcript` })).body) as {
      entries: { kind: string; pending?: boolean }[]
    }
    assert.equal(
      after.entries.some((entry) => entry.kind === 'bash' && entry.pending),
      false,
    )
  } finally {
    registry.drivers.delete(id)
    forget(id)
  }
})

/*
 * Stopping a `!` line, end to end.
 *
 * A session runs one `!` command at a time, so a run nobody is going to finish — the
 * `gcloud auth login` waiting on a browser tab that was closed — is a session that cannot run
 * another line until the timeout comes round, minutes later. What is only reachable from out
 * here is the round trip the page actually makes: it finds the run in the conversation, names
 * that run in the stop, and runs the next line on the answer. If the stop replied before the
 * command was really over, that last step would come back as the same refusal it was for.
 */
test('a `!` line can be stopped, and the line that was waiting on it runs straight away', async () => {
  const file = await transcript([
    {
      type: 'user',
      uuid: 'b8e04d71-0000-4000-8000-000000000019',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    },
  ])
  const id = 'b8e04d71-0000-4000-8000-000000000002'
  seed({ id, cwd: os.tmpdir(), transcriptPath: file })

  try {
    // `cat` holds the output pipe open for as long as it lives, so a stop that signalled only
    // the shell would leave this run going and the session still blocked.
    const ran = await sendJson({
      method: 'POST',
      url: `/api/sessions/${id}/bash`,
      body: { command: 'sleep 30 | cat' },
    })
    assert.equal(ran.status, 202, ran.body)
    const runId = (JSON.parse(ran.body) as { run: { id: string } }).run.id

    const blocked = await sendJson({
      method: 'POST',
      url: `/api/sessions/${id}/bash`,
      body: { command: 'echo waiting' },
    })
    assert.equal(blocked.status, 409, 'a second `!` line waits for the first')

    // The page has no run ids of its own: it stops the entry it is looking at, and the id
    // comes back out of the uuid that entry was given.
    const page = JSON.parse((await send({ url: `/api/sessions/${id}/transcript` })).body) as {
      entries: { kind: string; uuid: string; running?: boolean }[]
    }
    const shown = page.entries.find((entry) => entry.kind === 'bash' && entry.running)
    assert.equal(pendingRunId(shown?.uuid ?? ''), runId)

    const stopped = await sendJson({
      method: 'POST',
      url: `/api/sessions/${id}/bash/stop`,
      body: { run: pendingRunId(shown?.uuid ?? '') },
    })
    assert.equal(stopped.status, 200, stopped.body)
    assert.equal((JSON.parse(stopped.body) as { run: { running: boolean } }).run.running, false)

    const after = await sendJson({
      method: 'POST',
      url: `/api/sessions/${id}/bash`,
      body: { command: 'echo after' },
    })
    assert.equal(after.status, 202, after.body)
  } finally {
    forget(id)
  }
})

/*
 * The new-session sheet types a first prompt for a session that does not exist yet, so the
 * `@` and `/` menus behind it cannot be looked up by session id. These routes take the
 * folder the sheet is pointed at instead, and everything below is what the sheet needs from
 * them: a folder no session has ever run in still answers, and the answer is about that
 * folder rather than about the machine.
 */
test('the file menu answers for a folder no session knows about', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aivis-files-'))
  tempDirs.push(dir)
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.writeFile(path.join(dir, 'src', 'tiers.ts'), 'export const tiers = []\n')

  const answer = await send({ url: `/api/files?cwd=${encodeURIComponent(dir)}&q=tiers` })
  assert.equal(answer.status, 200, answer.body)
  const body = JSON.parse(answer.body) as { hits: { path: string; name: string; dir: string }[] }
  assert.deepEqual(body.hits[0], { path: 'src/tiers.ts', name: 'tiers.ts', dir: 'src' })
})

test('a folder the sheet is about to create lists nothing rather than failing', async () => {
  const dir = path.join(os.tmpdir(), 'aivis-not-created-yet-12345')
  const answer = await send({ url: `/api/files?cwd=${encodeURIComponent(dir)}&q=` })
  assert.equal(answer.status, 200, answer.body)
  assert.deepEqual((JSON.parse(answer.body) as { hits: unknown[] }).hits, [])
})

test('the command menu offers the chosen folder its own skills', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aivis-commands-'))
  tempDirs.push(dir)
  const skill = path.join(dir, '.claude', 'skills', 'shipit')
  await fs.mkdir(skill, { recursive: true })
  await fs.writeFile(
    path.join(skill, 'SKILL.md'),
    '---\nname: shipit\ndescription: cut a release\n---\n\nDo the release.\n',
  )

  const answer = await send({ url: `/api/commands?cwd=${encodeURIComponent(dir)}&q=shipit` })
  assert.equal(answer.status, 200, answer.body)
  const body = JSON.parse(answer.body) as {
    hits: { name: string; description: string; kind: string; source: string; runnable: boolean }[]
  }
  assert.deepEqual(body.hits[0], {
    name: 'shipit',
    description: 'cut a release',
    kind: 'skill',
    source: 'project',
    runnable: true,
  })
})

test('both menus refuse a request that names no folder', async () => {
  for (const route of ['/api/files', '/api/commands']) {
    const answer = await send({ url: `${route}?q=x` })
    assert.equal(answer.status, 400, `${route}: ${answer.body}`)
    assert.match(answer.body, /cwd is required/)
  }
})
