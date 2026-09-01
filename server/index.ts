import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { promises as fs, promises as fsp, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import chokidar from 'chokidar'
import { WebSocketServer, type WebSocket } from 'ws'
import { config } from './config.ts'
import { Fleet } from './fleet.ts'
import { localImageType, readImage, readTranscript, transcriptMentions } from './transcriptView.ts'
import { listSubagents, listWorkflows, parentReader, readAgentTools } from './agents.ts'
import { DriverRegistry } from './driver.ts'
import { searchFiles } from './files.ts'
import { changeSet, fileChange } from './changes.ts'
import { clearBash, finishedBash, forgetBash, pendingBash, startBashLine } from './bash.ts'
import { bashStderr, formatBashPrefix } from '../shared/bash.ts'
import { searchCommands, expandCommand } from './commands.ts'
import { parked } from './parked.ts'
import { ambiguityFor, endSession } from './terminate.ts'
import { blockUsage } from './blocks.ts'
import { attentionQueue } from './attention.ts'
import { branchState, browse, checkoutBranch, ensureDir, resolveDir, trustProject } from './projects.ts'
import { defaults } from './defaults.ts'
import { deliverToSession } from './deliver.ts'
import { LOCAL_NAMES, readsAsJson, sameOrigin } from './origin.ts'
import { clientBuildId, compareBuild } from './build.ts'
import type { AskDecision, OutgoingImage, PendingAsk, ServerMessage } from '../shared/types.ts'

const clients = new Set<WebSocket>()
// Exported for the same reason `fleet` below is: a test driving `handleRequest` has to be
// able to put a driver in front of the message route, which is the only path on which a
// held `!` run can be seen to travel with the message it was flushed into.
export const drivers = new DriverRegistry((status) => {
  broadcast({ kind: 'driver', status })
  // A decision a driver is holding is queued from here and nowhere else — Claude Code writes
  // no transcript record for a permission prompt until it is answered — so the queue has to
  // be pushed on the driver's word rather than waiting for a scan that will find nothing.
  pushAttention()
})
// The fleet reads transcripts, which say nothing while a session waits on a permission
// prompt, so it asks the driver registry whether the silence has a reason. It is exported
// so that a test driving `handleRequest` can put a session in front of a route without
// running a scan of the whole store.
export const fleet = new Fleet((sessionId) => (drivers.get(sessionId)?.status.asks.length ?? 0) > 0)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(rootDir, 'dist')

/**
 * The front end this process started with, read once at start-up.
 *
 * Taken here rather than on the first request so that it is genuinely the build the server
 * booted with: a rebuild that lands before anybody opens the page would otherwise be
 * recorded as this process's own, and the disagreement it causes would go unreported.
 */
const bootedWith = clientBuildId(distDir)

/** How often each connected page is pinged to find out whether it is still there. */
const HEARTBEAT_MS = 30_000

/**
 * How much unsent fleet data a page may have queued before it is treated as gone.
 *
 * A browser that stopped reading — a laptop that slept mid-connection, a Wi-Fi drop —
 * leaves its socket looking open, and every refresh queues another update behind the ones
 * it never took. A few megabytes is far more backlog than a dashboard that is being read
 * ever holds, so past it the page is not coming back and the memory is better reclaimed.
 */
const MAX_CLIENT_BUFFER_BYTES = 4 * 1024 * 1024

/**
 * What each driven session is holding a decision on, keyed by session id.
 *
 * A session appears here with an empty list when aivis drives it and it is holding
 * nothing, because the queue needs to tell "asking, and you can answer it here" apart from
 * "asking, and only its own terminal can".
 */
function heldDecisions(): Map<string, PendingAsk[]> {
  return new Map(drivers.statuses().map((status) => [status.sessionId, status.asks]))
}

function broadcast(message: ServerMessage): void {
  const payload = JSON.stringify(message)
  for (const client of clients) {
    if (client.readyState !== client.OPEN) continue
    // A client that has stopped reading is still open as far as this side is concerned, so
    // without this the fleet would keep queueing updates into a buffer nothing drains.
    if (client.bufferedAmount > MAX_CLIENT_BUFFER_BYTES) {
      clients.delete(client)
      client.terminate()
      continue
    }
    client.send(payload)
  }
}

/**
 * Push the attention queue to every connected page.
 *
 * Called wherever something that could change the queue has changed: a session whose
 * displayed state moved, a session that left the fleet, and a driver reporting a decision it
 * is holding — that last one being the only source for a permission prompt, which writes
 * nothing to a transcript until it is answered.
 *
 * The queue is derived from state already in memory, so building it costs nothing worth
 * measuring, and it is small. Sending it is what lets a page in a background tab hear about
 * a session that needs its reader: a browser throttles a hidden tab's timers to about once a
 * minute and may stop running them altogether, so anything that polls is at its slowest
 * exactly when the page has most need of being told.
 */
function pushAttention(): void {
  broadcast({ kind: 'attention', queue: attentionQueue(fleet.all(), heldDecisions()) })
}

/**
 * Recompute the fleet and push what moved.
 *
 * Refreshes overlap when a scan takes longer than the interval, so a running refresh
 * suppresses the next one rather than queueing it.
 */
let refreshing = false
async function refresh(): Promise<void> {
  if (refreshing) return
  refreshing = true
  try {
    const { changed, removed } = await fleet.refresh()
    if (changed.length > 0) broadcast({ kind: 'update', sessions: changed })
    if (removed.length > 0) {
      // Runs are held in memory against a session id, and a session that has left the fleet
      // is never going to send the message that would flush them.
      for (const id of removed) forgetBash(id)
      broadcast({ kind: 'removed', ids: removed })
    }
    // Only when something moved. A scan that found the fleet exactly as it left it has not
    // changed the queue either, and a page has no use for being told so every few seconds.
    if (changed.length > 0 || removed.length > 0) pushAttention()
  } catch (err) {
    console.error('[aivis] refresh failed:', err)
  } finally {
    refreshing = false
  }
}

/** Base64 inflates bytes by about a third, so a few screenshots need real headroom. */
const MAX_BODY_BYTES = 40 * 1024 * 1024
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/**
 * Validate the images posted with a message.
 *
 * Anything that is not one of the four types Claude accepts, or is larger than the
 * per-image cap, is rejected by name rather than silently dropped.
 */
function readImages(value: unknown): { images: OutgoingImage[]; error: string | null } {
  if (value === undefined) return { images: [], error: null }
  if (!Array.isArray(value)) return { images: [], error: 'images must be an array' }
  const images: OutgoingImage[] = []
  for (const entry of value) {
    const item = entry as Partial<OutgoingImage>
    if (typeof item?.mediaType !== 'string' || typeof item?.data !== 'string') {
      return { images: [], error: 'each image needs mediaType and base64 data' }
    }
    if (!IMAGE_TYPES.has(item.mediaType)) {
      return { images: [], error: `unsupported image type ${item.mediaType}` }
    }
    if (item.data.length > MAX_IMAGE_BYTES) {
      return { images: [], error: `image ${item.name ?? ''} is larger than 8 MB` }
    }
    images.push({ mediaType: item.mediaType, data: item.data, name: item.name })
  }
  return { images, error: null }
}

/**
 * Validate an answer posted for a decision a session stopped for.
 *
 * Answers are keyed by each question's own text rather than by position, because that is
 * how Claude Code keys them and matching the wire is what keeps aivis from having to guess
 * which question an index refers to. A value is one option's label, an array of labels for
 * a multi-select, or whatever was typed instead of choosing.
 */
function readDecision(body: Record<string, unknown>): { decision: AskDecision | null; error: string | null } {
  if (body.behavior === 'deny') {
    const message = typeof body.message === 'string' ? body.message : undefined
    return { decision: { behavior: 'deny', message }, error: null }
  }
  if (body.behavior !== 'allow') {
    return { decision: null, error: 'behavior must be "allow" or "deny"' }
  }
  const suggestions = body.suggestions === true
  const raw = body.answers
  if (raw === undefined) return { decision: { behavior: 'allow', suggestions }, error: null }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { decision: null, error: 'answers must be an object keyed by question text' }
  }
  const answers: Record<string, string | string[]> = {}
  for (const [question, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      answers[question] = value
    } else if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      answers[question] = value as string[]
    } else {
      return { decision: null, error: `the answer to "${question}" must be a string or an array of strings` }
    }
  }
  return { decision: { behavior: 'allow', answers, suggestions }, error: null }
}

/** A body sent as something aivis does not read, which is a 415 rather than a bad request. */
class UnsupportedMediaType extends Error {}

/** Collect a JSON request body, refusing anything unreasonably large or not sent as JSON. */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  // `handleRequest` has already refused any POST that did not claim JSON, so this repeats a
  // check that has run. It stays because the guarantee belongs to the reader rather than to
  // one caller: nothing is parsed as JSON that did not say it was JSON, whichever method or
  // route reaches this next.
  if (!readsAsJson(req.headers['content-type'])) {
    throw new UnsupportedMediaType('this endpoint reads JSON — send Content-Type: application/json')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * Answer a request whose body could not be read.
 *
 * A media type this server will not parse is 415 rather than 400: nothing about the request
 * is malformed, aivis simply does not read bodies sent as anything but JSON.
 */
function badBody(res: ServerResponse, err: unknown): void {
  json(res, err instanceof UnsupportedMediaType ? 415 : 400, { error: String(err) })
}

/**
 * Decode one segment of a route's path, answering 400 when it cannot be decoded.
 *
 * `new URL()` leaves the path percent-encoded, so a segment like `%E0%A4%A` reaches the
 * route matches below exactly as it was sent and `decodeURIComponent` throws a `URIError`
 * on it. Nothing awaits this handler, so that throw would arrive as an unhandled rejection
 * rather than as a response: one malformed request would take the daemon down and orphan
 * every session it is driving. An id that is not valid encoding names nothing, which is an
 * ordinary bad request, so it is answered as one and the route returns.
 */
function decodeSegment(res: ServerResponse, raw: string): string | null {
  try {
    return decodeURIComponent(raw)
  } catch {
    json(res, 400, { error: 'that path is not valid percent-encoding' })
    return null
  }
}

/** Quote a path for a shell command line, so directories with spaces survive a copy and paste. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The `claude --resume` line the handoff sheet offers to copy.
 *
 * Nothing here runs it — it is text handed to a clipboard, and the shell that eventually
 * reads it is the user's own — but that is exactly why both halves are quoted. The cwd and
 * the session id come out of a `.jsonl` in the projects store, and any local process may
 * write a file there, so neither is aivis's own string. `server/transcripts.ts` already
 * refuses to build a session whose id is not plausible, and this quoting is the second
 * fence: it is what keeps a widened id alphabet, or a directory with a quote in its name,
 * from turning a paste into two commands. It is a named function rather than a template in
 * the route so that the quoting can be tested against ids the transcript layer would now
 * never produce.
 */
export function resumeCommand(session: { id: string; cwd: string }): string {
  return `cd ${shellQuote(session.cwd)} && claude --resume ${shellQuote(session.id)}`
}

/**
 * Headers that keep a file served out of a session from being read as a page.
 *
 * The two image routes hand back bytes aivis did not write — base64 out of a transcript
 * record, or a file on disk a message pointed at — and the conversation view renders each
 * one as a link that opens at the top level. A browser that decides such a response is a
 * document runs whatever script it holds in aivis's own origin, where the API asks for no
 * credential, so the response has to say plainly that it is not one: `nosniff` pins the
 * type to the one declared rather than letting sniffed content promote it, the sandbox
 * directive drops the document into an opaque origin with scripts off, and `default-src
 * 'none'` leaves it nothing it may fetch. The filename is only a courtesy to whoever saves
 * the picture, so it is cut down to an alphabet a header value can carry rather than
 * encoded: it comes off disk or out of a query string and may hold quotes or newlines.
 */
export function inertFileHeaders(filename: string): Record<string, string> {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80)
  return {
    'X-Content-Type-Options': 'nosniff',
    // `frame-ancestors` is repeated from the blanket policy in `handleRequest` because this
    // header replaces it rather than adding to it: a `Content-Security-Policy` passed to
    // `writeHead` wins over one set with `setHeader`, so leaving it out here would make
    // these two routes the only framable responses aivis serves.
    'Content-Security-Policy': `sandbox; default-src 'none'; frame-ancestors 'none'`,
    'Content-Disposition': `inline; filename="${safe || 'image'}"`,
  }
}

/**
 * Permission modes a new session may be started in.
 *
 * The value reaches the `claude` command line, so it is matched against the list the new
 * session sheet offers rather than passed through. An unknown mode would only make the
 * process refuse to start, but a request that names one is not coming from this app.
 */
const PERMISSION_MODES = new Set(['auto', 'acceptEdits', 'bypassPermissions', 'plan', 'default'])

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!config.serveStatic) return false
  const requested = (req.url ?? '/').split('?')[0] ?? '/'
  const candidate = path.join(distDir, requested === '/' ? 'index.html' : requested)
  const resolved = path.resolve(candidate)
  // Compare against the directory plus a separator: a bare prefix test would also accept a
  // sibling whose name merely starts with `dist`.
  const inside = resolved === distDir || resolved.startsWith(distDir + path.sep)
  const target = inside ? resolved : path.join(distDir, 'index.html')
  try {
    const body = await fs.readFile(target)
    res.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(target)] ?? 'application/octet-stream' })
    res.end(body)
    return true
  } catch {
    try {
      const body = await fs.readFile(path.join(distDir, 'index.html'))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(body)
      return true
    } catch {
      return false
    }
  }
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Refuse to be put in somebody else's page, on every response this handler can produce.
  //
  // The origin gate below cannot cover this, because framing is not a request the gate ever
  // sees as foreign: loading a document into an iframe is an ordinary GET navigation, and a
  // browser attaches no `Origin` header to one, so it takes the "no Origin, allow it" path
  // and the dashboard is served. Once framed the app boots and its own fetches and its
  // WebSocket carry aivis's real origin, so everything works — and a page that cannot read
  // a cross-origin frame can still position it, make it transparent, and put its own bait
  // under the button that answers a permission prompt or ends a session. Loopback is
  // "potentially trustworthy" to Chrome and Firefox, so an https page frames it without
  // tripping mixed content. The `<meta http-equiv>` policy in `index.html` is no substitute:
  // CSP requires `frame-ancestors` to be ignored when it arrives in a meta element, which is
  // why this is a response header set on every answer, including the 403 below.
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Content-Security-Policy', `frame-ancestors 'none'`)

  if (!sameOrigin(req.headers, config)) {
    json(res, 403, { error: 'refused: this request did not come from a page aivis is served on' })
    return
  }

  // A POST has to say it carries JSON, whether or not the route it reaches reads a body.
  //
  // `readBody` demands the same type, but two routes act on a live session without reading
  // one — `/interrupt` and `/stop` — and a POST with no body carries no `Content-Type` at
  // all, which leaves it a CORS "simple request": no preflight is sent, so the origin gate
  // is the only thing in front of it. That gate trusts every loopback origin whatever its
  // port, deliberately, so a page served by anything else on this machine — a dev server, a
  // docs preview, an XSS in another local app — could stop a session outright. Asking for
  // the type here forces such an attempt into a preflight this server never answers, and
  // covers whatever route is added next as well. Only POST needs it: GET and HEAD change
  // nothing, and DELETE, PUT and PATCH are not simple methods, so a cross-site attempt at
  // one is already preflighted.
  if (req.method === 'POST' && !readsAsJson(req.headers['content-type'])) {
    badBody(res, new UnsupportedMediaType('this endpoint reads JSON — send Content-Type: application/json'))
    return
  }

  // `Host` is a client-supplied string, and one that is not a hostname — a value with a
  // space in it, say — makes this base unparseable. On the default loopback bind the check
  // above has already refused anything that is not a name for this machine, but a
  // deliberate LAN bind cannot make that check, so a request that arrives with a Host this
  // cannot parse is answered as the bad request it is.
  let url: URL
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  } catch {
    json(res, 400, { error: 'that request had a Host or path this server could not parse' })
    return
  }

  if (url.pathname === '/api/health') {
    json(res, 200, { ok: true, projectsDir: config.projectsDir, sessions: fleet.all().length })
    return
  }

  // Whether the page asking is newer than the server answering it. A server that predates
  // this route answers the static fallthrough below instead, which hands back `index.html`
  // — so the page reads a reply that is not the JSON it asked for as the same disagreement
  // by another name, and that is the reply the servers this exists for actually give.
  if (url.pathname === '/api/build') {
    json(res, 200, compareBuild(config.serveStatic, await bootedWith, await clientBuildId(distDir)))
    return
  }

  if (url.pathname === '/api/sessions' && req.method !== 'POST') {
    json(res, 200, { sessions: fleet.all() })
    return
  }

  if (url.pathname === '/api/processes') {
    json(res, 200, { processes: await fleet.processes() })
    return
  }

  // What a new session inherits, and the thresholds the index quotes when it explains
  // what `stalled` and `waiting on you` mean. `cwd` is optional: without one the answer
  // is your user-level default, which is what the sheet shows before a project is picked.
  if (url.pathname === '/api/defaults') {
    const requested = url.searchParams.get('cwd')?.trim()
    json(res, 200, await defaults(requested ? resolveDir(requested) : null))
    return
  }

  const handoff = url.pathname.match(/^\/api\/sessions\/([^/]+)\/handoff$/)
  if (handoff) {
    const id = decodeSegment(res, handoff[1] as string)
    if (id === null) return
    const session = fleet.get(id)
    if (!session) {
      json(res, 404, { error: 'unknown session' })
      return
    }
    json(res, 200, {
      cwd: session.cwd,
      command: resumeCommand(session),
    })
    return
  }

  const transcript = url.pathname.match(/^\/api\/sessions\/([^/]+)\/transcript$/)
  if (transcript) {
    const id = decodeSegment(res, transcript[1] as string)
    if (id === null) return
    const session = fleet.get(id)
    if (!session) {
      json(res, 404, { error: 'unknown session' })
      return
    }
    // The whole transcript is read; `limit` only guards against a pathological one.
    const limit = Math.min(Number(url.searchParams.get('limit')) || 5000, 50_000)
    try {
      const page = await readTranscript(session.transcriptPath, session.id, limit)
      // A `!` run that has not been sent yet is in no transcript, because aivis cannot write
      // to one — it reaches the file only when it travels in front of a message. Appending it
      // here is what makes it survive a reload, and what lets the page watch a slow command
      // finish: the same entry comes back with `running` false and its output filled in.
      for (const run of pendingBash(session.id)) {
        page.entries.push({
          kind: 'bash',
          uuid: `pending:${run.id}`,
          at: run.at,
          command: run.command,
          stdout: run.stdout,
          stderr: bashStderr(run),
          exitCode: run.exitCode,
          running: run.running,
          pending: true,
        })
      }
      json(res, 200, page)
    } catch (err) {
      json(res, 500, { error: String(err) })
    }
    return
  }

  const imageRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)\/image$/)
  if (imageRoute) {
    const id = decodeSegment(res, imageRoute[1] as string)
    if (id === null) return
    const session = fleet.get(id)
    const uuid = url.searchParams.get('uuid')
    const index = Number(url.searchParams.get('index') ?? 0)
    if (!session || !uuid) {
      json(res, 404, { error: 'unknown image' })
      return
    }
    try {
      const image = await readImage(session.transcriptPath, uuid, index, 64 * 1024 * 1024)
      if (!image) {
        json(res, 404, { error: 'image not found in the loaded transcript window' })
        return
      }
      // The type is whatever the record says it is, and a record is not necessarily
      // something aivis wrote: a `.jsonl` another local process dropped into the store can
      // call its base64 `text/html`, and serving that back would put a page of somebody
      // else's writing in this origin. Only the four types Claude itself accepts are
      // served, and the rejected type is not echoed back, because it is an unbounded string
      // from the same untrusted record.
      if (!IMAGE_TYPES.has(image.mediaType)) {
        json(res, 415, { error: 'that record stores its image as a type aivis does not serve' })
        return
      }
      // A transcript is append-only, so a record's image never changes once written.
      res.writeHead(200, {
        'Content-Type': image.mediaType,
        'Content-Length': image.bytes.length,
        'Cache-Control': 'private, max-age=31536000, immutable',
        ...inertFileHeaders(`${uuid}-${index}.${image.mediaType.replace('image/', '')}`),
      })
      res.end(image.bytes)
    } catch (err) {
      json(res, 500, { error: String(err) })
    }
    return
  }

  // Serve a local image a message links to by absolute path.
  const localFileRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)\/localfile$/)
  if (localFileRoute) {
    const id = decodeSegment(res, localFileRoute[1] as string)
    if (id === null) return
    const session = fleet.get(id)
    const target = url.searchParams.get('path')
    if (!session || !target) {
      json(res, 404, { error: 'unknown file' })
      return
    }
    // A path names one file only when it is already absolute and already normalised. A
    // relative one would be opened against whatever directory the daemon happens to have
    // been started in, and a `..` segment turns a mention of one file into a read of
    // another beside it, so a path `path.resolve` would rewrite is refused rather than
    // repaired: the string searched for in the transcript below has to be the very string
    // that opens the file.
    if (!path.isAbsolute(target) || path.resolve(target) !== target) {
      json(res, 400, { error: 'that path is not an absolute, normalised path' })
      return
    }
    const mime = localImageType(target)
    if (!mime) {
      json(res, 415, { error: 'only images are served from the filesystem' })
      return
    }
    try {
      if (!(await transcriptMentions(session.transcriptPath, target, 32 * 1024 * 1024))) {
        json(res, 403, { error: 'this conversation does not reference that path' })
        return
      }
      const bytes = await fsp.readFile(target)
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': bytes.length,
        'Cache-Control': 'private, max-age=300',
        ...inertFileHeaders(path.basename(target)),
      })
      res.end(bytes)
    } catch {
      json(res, 404, { error: 'file is gone' })
    }
    return
  }

  const agentsRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)\/agents$/)
  if (agentsRoute) {
    const id = decodeSegment(res, agentsRoute[1] as string)
    if (id === null) return
    const session = fleet.get(id)
    if (!session) {
      json(res, 404, { error: 'unknown session' })
      return
    }
    // Both lists link back into this session's own transcript, so they share one read of it.
    const readParent = parentReader(session.transcriptPath, session.id)
    // Whether anything of this session's can still be running, which decides for both lists
    // whether an agent that stopped writing is working or was killed where it stood.
    const parentAlive = session.livePids.length > 0 || drivers.get(session.id) !== undefined
    const [subagents, workflows] = await Promise.all([
      listSubagents(
        session.transcriptPath,
        { parentAlive, staleAfterMs: config.staleAfterMs },
        readParent,
      ),
      listWorkflows(
        session.transcriptPath,
        {
          parentAlive,
          staleAfterMs: config.staleAfterMs,
          // What the session says is still outstanding, which is the only thing that can
          // tell a run still going from one killed where it stood.
          outstanding: session.background.map((task) => task.toolUseId),
        },
        readParent,
      ),
    ])
    json(res, 200, { subagents, workflows })
    return
  }

  // One agent's own tool calls, read from its transcript only when its detail is opened.
  const agentTools = url.pathname.match(/^\/api\/sessions\/([^/]+)\/agents\/([^/]+)\/tools$/)
  if (agentTools) {
    const id = decodeSegment(res, agentTools[1] as string)
    if (id === null) return
    const agentId = decodeSegment(res, agentTools[2] as string)
    if (agentId === null) return
    const session = fleet.get(id)
    if (!session) {
      json(res, 404, { error: 'unknown session' })
      return
    }
    // The id names a file, so nothing but an id shape is allowed anywhere near a path.
    if (!/^[0-9a-zA-Z_-]{1,64}$/.test(agentId)) {
      json(res, 400, { error: 'bad agent id' })
      return
    }
    json(res, 200, { tools: await readAgentTools(session.transcriptPath, agentId) })
    return
  }

  const messageRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)\/message$/)
  if (messageRoute && req.method === 'POST') {
    const id = decodeSegment(res, messageRoute[1] as string)
    if (id === null) return
    const session = fleet.get(id)
    if (!session) {
      json(res, 404, { error: 'unknown session' })
      return
    }
    let body: Record<string, unknown>
    try {
      body = await readBody(req)
    } catch (err) {
      badBody(res, err)
      return
    }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    const { images, error } = readImages(body.images)
    if (error) {
      json(res, 400, { error })
      return
    }
    if (!text && images.length === 0) {
      json(res, 400, { error: 'send some text or at least one image' })
      return
    }

    // `!` lines that have finished since the last message travel in front of this one, which
    // is what makes a run context for what you went on to ask rather than a turn of its own.
    // They are read before the delivery path is chosen because every path carries them, and
    // dropped only once a path has actually taken them: a run cleared on a send that failed
    // would be a command that ran and was never seen by anyone.
    //
    // A command still running is left behind by `finishedBash` and goes with whatever message
    // follows it. Waiting for it would make sending a message block on a `!npm test`, and half
    // a run is not context.
    const held = finishedBash(session.id)
    const prefix = formatBashPrefix(held)
    const flush = (): void => clearBash(session.id, held.map((run) => run.id))

    // What happens to a `/command` depends entirely on how the message is delivered, so the
    // path is chosen first and the text is prepared for the path it is taking.
    //
    // A session aivis drives reads its messages on standard input, where Claude Code parses
    // slash commands itself, exactly as it does for anything typed in a terminal: it
    // advertises the ones it takes in its init event — 88 of them, `/effort` and `/model`
    // and `/compact` among them — and runs them. So the text goes as written, unexpanded.
    // That is both simpler and more faithful than aivis paraphrasing a skill into a request
    // to invoke it, and it is the only way the built-ins can work at all.
    const running = drivers.get(session.id)
    if (running) {
      if (!running.send(prefix + text, images)) {
        json(res, 500, { error: 'driver is not accepting messages', status: running.status })
        return
      }
      flush()
      json(res, 202, { delivery: 'driver', status: running.status })
      return
    }

    // The socket is the path that cannot: a session queues what arrives there with slash
    // command parsing turned off, so a command delivered whole would land as literal text
    // and quietly do nothing. Expanding it first is what makes a skill or a prompt command
    // work anyway. A built-in has nothing to expand into — it is an instruction to the
    // client rather than a prompt — so it is refused, and the message says that this is
    // about the session being someone else's rather than about aivis.
    let outgoing = text
    if (text && session.livePids.length > 0 && body.takeover !== true) {
      const expansion = await expandCommand(session.cwd, text)
      if (expansion?.status === 'terminal-only') {
        json(res, 400, {
          error:
            `/${expansion.name} has to run in the session's own terminal. aivis reaches this ` +
            `session over its message socket, which does not run slash commands. Commands do ` +
            `work in sessions aivis drives.`,
          terminalOnly: expansion.name,
        })
        return
      }
      if (expansion?.status === 'expanded') outgoing = expansion.text
    }
    // After the expansion rather than before it: `expandCommand` matches a leading `/`, and a
    // message with a run in front of it no longer starts with one.
    outgoing = prefix + outgoing

    // A session running in a terminal is reached over its own socket — the transport
    // behind Claude Code's cross-session messaging — so the terminal and aivis write to
    // one live conversation, mid-turn included. `takeover` forces the old
    // resume-as-a-second-process path.
    //
    // The socket closes without acknowledging anything, so the `uuid` handed back is the
    // receipt: the session records the message under it when it takes it off the queue,
    // and the page watches the transcript for it rather than claiming a delivery it cannot
    // see. `peer` says plainly that this arrives without the user's authority.
    if (session.livePids.length > 0 && body.takeover !== true) {
      const priority =
        body.priority === 'now' || body.priority === 'later' ? body.priority : 'next'
      // A delivery can fail because aivis refused to write the attachments rather than
      // because the socket was gone, and only the outcome knows which.
      let refusal: string | undefined
      for (const pid of session.livePids) {
        const outcome = await deliverToSession(pid, outgoing, images, {
          sessionId: session.id,
          priority,
        })
        if (outcome.ok) {
          flush()
          void refresh()
          json(res, 202, {
            delivery: 'socket',
            pid,
            uuid: outcome.uuid,
            attachments: outcome.attachments,
            priority,
            peer: true,
          })
          return
        }
        refusal = outcome.error ?? refusal
      }
      // The socket was unreachable, or aivis declined to write the attachments — say so and
      // offer the resume fallback, rather than silently starting a second process the user
      // did not ask for. `detail` carries the reason when there is one to give.
      json(res, 409, {
        error: 'could not reach the running session',
        pids: session.livePids,
        detail: refusal,
        hint: 'Send again with takeover: true to resume it here as a separate process.',
      })
      return
    }

    // Resuming the session makes aivis its driver, so this is the native path too and the
    // text goes as written.
    const driver = drivers.start(session.id, session.cwd)
    if (!driver.send(prefix + text, images)) {
      json(res, 500, { error: 'driver is not accepting messages', status: driver.status })
      return
    }
    flush()
    json(res, 202, { delivery: 'resume', status: driver.status })
    return
  }

  // A `!` bash line. It runs here, in the session's own directory, and is held rather than
  // sent: what it printed goes out in front of the next message, which is what the terminal
  // client does and why a `!` line provokes no reply of its own.
  //
  // This is the one route that runs what the user typed rather than what a model asked for,
  // so nothing about it reaches a permission prompt. `startBashLine` is what decides whether
  // it may run at all; `server/bash.ts` says what that check does and does not claim.
  const bashRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bash$/)
  if (bashRoute && req.method === 'POST') {
    const id = decodeSegment(res, bashRoute[1] as string)
    if (id === null) return
    const session = fleet.get(id)
    if (!session) {
      json(res, 404, { error: 'unknown session' })
      return
    }
    let body: Record<string, unknown>
    try {
      body = await readBody(req)
    } catch (err) {
      badBody(res, err)
      return
    }
    const command = typeof body.command === 'string' ? body.command.trim() : ''
    if (!command) {
      json(res, 400, { error: 'send a command to run' })
      return
    }
    const started = startBashLine(session.id, session.cwd, command)
    if (!started.ok) {
      json(res, started.status, { error: started.error })
      return
    }
    // 202 rather than 200: the command has started, not finished. The page reads the rest off
    // the transcript endpoint, which carries a still-running run as an entry of its own.
    json(res, 202, { run: started.run })
    return
  }

  // Cut the current turn short without ending the session. Only a session aivis drives can
  // be interrupted: the control request travels on the process's standard input, and a
  // session running in a terminal does not expose one. Its socket carries no interrupt
  // either — the terminal owns that key — so this says so rather than pretending.
  const interruptRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)\/interrupt$/)
  if (interruptRoute && req.method === 'POST') {
    const id = decodeSegment(res, interruptRoute[1] as string)
    if (id === null) return
    const driver = drivers.get(id)
    if (!driver) {
      const session = fleet.get(id)
      json(res, 409, {
        error:
          session && session.livePids.length > 0
            ? 'this session runs in a terminal, and only the terminal can interrupt it — press escape there'
            : 'no driver for that session',
      })
      return
    }
    if (!driver.interrupt()) {
      json(res, 409, { error: 'the session is not working', status: driver.status })
      return
    }
    json(res, 202, { interrupted: true, status: driver.status })
    return
  }

  // Answer a question, or decide a permission prompt, that a session has stopped for.
  //
  // Only a session aivis drives can be answered. The answer travels as a control response
  // on the process's own standard input — the same channel the interrupt uses, and the
  // only one that carries your authority rather than another session's. A session running
  // in a terminal owns its own dialogue: aivis can see the question it asked and say so on
  // the index, but the answer has to be given where it was asked.
  const answerRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)\/answer$/)
  if (answerRoute && req.method === 'POST') {
    const id = decodeSegment(res, answerRoute[1] as string)
    if (id === null) return
    const driver = drivers.get(id)
    if (!driver) {
      const session = fleet.get(id)
      json(res, 409, {
        error:
          session && session.livePids.length > 0
            ? 'this session runs in a terminal, and only the terminal can answer it — answer it there'
            : 'no driver for that session',
      })
      return
    }
    let body: Record<string, unknown>
    try {
      body = await readBody(req)
    } catch (err) {
      badBody(res, err)
      return
    }
    const requestId = typeof body.requestId === 'string' ? body.requestId : ''
    if (!requestId) {
      json(res, 400, { error: 'requestId names the question being answered' })
      return
    }
    const { decision, error } = readDecision(body)
    if (!decision) {
      json(res, 400, { error })
      return
    }
    // A question that has gone is not an error worth alarming anyone about: the turn was
    // interrupted, or somebody answered it in a second tab. Saying which is enough.
    if (!driver.answer(requestId, decision)) {
      json(res, 409, { error: 'that question is no longer open', status: driver.status })
      return
    }
    void refresh()
    json(res, 202, { answered: true, status: driver.status })
    return
  }

  const stopRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/)
  if (stopRoute && req.method === 'POST') {
    const id = decodeSegment(res, stopRoute[1] as string)
    if (id === null) return
    const driver = drivers.get(id)
    if (!driver) {
      json(res, 404, { error: 'no driver for that session' })
      return
    }
    driver.stop()
    json(res, 200, { stopped: true })
    return
  }

  const filesRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)\/files$/)
  if (filesRoute) {
    const id = decodeSegment(res, filesRoute[1] as string)
    if (id === null) return
    const session = fleet.get(id)
    if (!session) {
      json(res, 404, { error: 'unknown session' })
      return
    }
    const limit = Math.min(Number(url.searchParams.get('limit')) || 12, 50)
    try {
      json(res, 200, await searchFiles(session.cwd, url.searchParams.get('q') ?? '', limit))
    } catch (err) {
      json(res, 500, { error: String(err) })
    }
    return
  }

  // What the session changed on disk. The base is a commit: `start` is the last one made
  // before the session began, `head` the tip, so the same session reads as "everything it
  // changed" or "what is still uncommitted" depending on which is asked for.
  const changesRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)\/changes$/)
  if (changesRoute) {
    const id = decodeSegment(res, changesRoute[1] as string)
    if (id === null) return
    const session = fleet.get(id)
    if (!session) {
      json(res, 404, { error: 'unknown session' })
      return
    }
    const base = url.searchParams.get('base') === 'head' ? 'head' : 'start'
    try {
      json(res, 200, await changeSet(session.cwd, base, session.startedAt))
    } catch (err) {
      json(res, 500, { error: String(err) })
    }
    return
  }

  const changeFileRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)\/changes\/file$/)
  if (changeFileRoute) {
    const id = decodeSegment(res, changeFileRoute[1] as string)
    if (id === null) return
    const session = fleet.get(id)
    if (!session) {
      json(res, 404, { error: 'unknown session' })
      return
    }
    const requested = url.searchParams.get('path')
    if (!requested) {
      json(res, 400, { error: 'path is required' })
      return
    }
    const base = url.searchParams.get('base') === 'head' ? 'head' : 'start'
    try {
      json(
        res,
        200,
        await fileChange(session.cwd, base, session.startedAt, requested, {
          context: Number(url.searchParams.get('context')) || 3,
          ignoreWhitespace: url.searchParams.get('whitespace') === 'ignore',
        }),
      )
    } catch (err) {
      json(res, 500, { error: String(err) })
    }
    return
  }

  // Finish a session: stop the process behind it so it reads as ended.
  const endRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)\/end$/)
  if (endRoute && req.method === 'POST') {
    const id = decodeSegment(res, endRoute[1] as string)
    if (id === null) return
    const session = fleet.get(id)
    if (!session) {
      json(res, 404, { error: 'unknown session' })
      return
    }
    let body: Record<string, unknown> = {}
    try {
      body = await readBody(req)
    } catch (err) {
      // A body that will not parse is fine here: it just means no force. A content type
      // aivis does not read is not, because swallowing it would leave the one route that
      // tolerates a bad body reachable as a cross-site POST that needs no preflight.
      if (err instanceof UnsupportedMediaType) {
        badBody(res, err)
        return
      }
    }

    // A session aivis drives is its own child, so stopping the driver is unambiguous. Its pid
    // is read before the driver is stopped and carried into `endSession` below: the
    // machine-wide scan may have attributed that same process to this session, and a process
    // aivis started itself is one it may stop without guessing whose it is. The pid comes only
    // from the driver registry — nothing from the request body may reach it, or the `--print`
    // refusal would become something the caller chooses.
    const own = drivers.get(session.id)
    const ownPid = own?.pid ?? null
    own?.stop()

    if (session.livePids.length === 0) {
      await parked.load()
      parked.finish(session.id)
      void refresh()
      json(res, 200, { ended: true, stopped: [], forced: [], skipped: [] })
      return
    }

    // Which process writes which transcript is not recorded anywhere, so a directory with
    // more than one live session cannot be ended on a guess without saying so first.
    const liveInCwd = fleet
      .all()
      .filter((other) => other.cwd === session.cwd && other.livePids.length > 0).length
    const ambiguity = await ambiguityFor(session.cwd, liveInCwd)
    if (ambiguity && body.force !== true) {
      json(res, 409, {
        error: 'more than one session is live in this directory',
        ambiguous: true,
        pids: session.livePids,
        ...ambiguity,
        hint: 'aivis cannot tell which process belongs to which conversation here. Send again with force: true to stop the process it has attributed to this session.',
      })
      return
    }

    // Marked before the signal, not after: a scan that is already reading transcripts would
    // otherwise record this session as alive and park it moments after it was stopped.
    // Deliberately finished is not the same as interrupted, so it must not come back parked.
    await parked.load()
    parked.finish(session.id)
    const outcome = await endSession(session.livePids, {
      owned: ownPid === null ? [] : [ownPid],
    })
    void refresh()
    json(res, 200, outcome)
    return
  }

  // Forget a parked session, so it drops back to being an ordinary ended one. The
  // transcript is untouched — this only changes how the session is presented.
  const parkRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)\/park$/)
  if (parkRoute && req.method === 'DELETE') {
    const id = decodeSegment(res, parkRoute[1] as string)
    if (id === null) return
    await parked.load()
    const dismissed = parked.dismiss(id)
    void refresh()
    json(res, 200, { dismissed })
    return
  }

  if (url.pathname === '/api/parked') {
    await parked.load()
    if (req.method === 'DELETE') {
      const cleared = parked.clear()
      void refresh()
      json(res, 200, { cleared })
      return
    }
    json(res, 200, { parked: parked.list() })
    return
  }

  const commandsRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)\/commands$/)
  if (commandsRoute) {
    const id = decodeSegment(res, commandsRoute[1] as string)
    if (id === null) return
    const session = fleet.get(id)
    if (!session) {
      json(res, 404, { error: 'unknown session' })
      return
    }
    const limit = Math.min(Number(url.searchParams.get('limit')) || 10, 40)
    try {
      json(res, 200, await searchCommands(session.cwd, url.searchParams.get('q') ?? '', limit))
    } catch (err) {
      json(res, 500, { error: String(err) })
    }
    return
  }

  // Projects known to aivis, for the new-session picker.
  if (url.pathname === '/api/projects') {
    const byCwd = new Map<string, { cwd: string; name: string; live: number; lastActivityAt: string }>()
    for (const session of fleet.all()) {
      const entry = byCwd.get(session.cwd) ?? {
        cwd: session.cwd,
        name: session.projectName,
        live: 0,
        lastActivityAt: session.lastActivityAt,
      }
      if (session.status !== 'ended') entry.live += 1
      if (session.lastActivityAt > entry.lastActivityAt) entry.lastActivityAt = session.lastActivityAt
      byCwd.set(session.cwd, entry)
    }
    json(res, 200, {
      projects: [...byCwd.values()].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
    })
    return
  }

  if (url.pathname === '/api/projects/branches') {
    const dir = url.searchParams.get('cwd')
    if (!dir) {
      json(res, 400, { error: 'cwd is required' })
      return
    }
    json(res, 200, await branchState(resolveDir(dir)))
    return
  }

  if (url.pathname === '/api/browse') {
    try {
      json(res, 200, await browse(url.searchParams.get('path') ?? ''))
    } catch (err) {
      json(res, 400, { error: String(err) })
    }
    return
  }

  /*
   * The `@` and `/` menus for a directory rather than for a session.
   *
   * The new-session sheet is typing the first prompt of a session that does not exist yet,
   * so it has no id to look a working directory up by — it has the folder it is about to
   * start in and nothing else. These take that folder directly and run the same two
   * searches the session-scoped routes run. A folder that has not been created yet answers
   * with an empty file list rather than an error, because the sheet creates it on start
   * and a picker that failed loudly in the meantime would be noise.
   */
  if (url.pathname === '/api/files' || url.pathname === '/api/commands') {
    const dir = url.searchParams.get('cwd')
    if (!dir) {
      json(res, 400, { error: 'cwd is required' })
      return
    }
    const files = url.pathname === '/api/files'
    const cap = files ? 50 : 40
    const limit = Math.min(Number(url.searchParams.get('limit')) || (files ? 12 : 10), cap)
    const query = url.searchParams.get('q') ?? ''
    try {
      const cwd = resolveDir(dir)
      const found = files
        ? await searchFiles(cwd, query, limit)
        : await searchCommands(cwd, query, limit)
      json(res, 200, found)
    } catch (err) {
      json(res, 500, { error: String(err) })
    }
    return
  }

  // Start a session, in an existing project or in a folder aivis has never seen.
  if (url.pathname === '/api/sessions' && req.method === 'POST') {
    let body: Record<string, unknown>
    try {
      body = await readBody(req)
    } catch (err) {
      badBody(res, err)
      return
    }

    const rawCwd = typeof body.cwd === 'string' ? body.cwd.trim() : ''
    if (!rawCwd) {
      json(res, 400, { error: 'cwd is required' })
      return
    }
    const cwd = resolveDir(rawCwd)
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    const { images, error: imageError } = readImages(body.images)
    if (imageError) {
      json(res, 400, { error: imageError })
      return
    }
    // A fresh process stays silent until it has work, so a session cannot be opened
    // empty — there would be nothing to wait for and nothing to show.
    if (!prompt && images.length === 0) {
      json(res, 400, { error: 'a new session needs a first prompt' })
      return
    }

    try {
      const created = await ensureDir(cwd)

      const branch = typeof body.branch === 'string' ? body.branch : ''
      if (branch) {
        const failure = await checkoutBranch(cwd, branch)
        if (failure) {
          json(res, 409, { error: `could not switch to ${branch}: ${failure}` })
          return
        }
      }

      // Print mode never asks about trust, but the terminal does, so a folder started
      // from here is marked trusted and stays that way for every later session in it.
      const trust = config.trustNewProjects
        ? await trustProject(cwd)
        : { trusted: false, alreadyTrusted: false }

      const driver = await drivers.startNew(
        {
          cwd,
          model: typeof body.model === 'string' && body.model ? body.model : undefined,
          permissionMode:
            typeof body.permissionMode === 'string' && PERMISSION_MODES.has(body.permissionMode)
              ? body.permissionMode
              : undefined,
          effort: typeof body.effort === 'string' && body.effort ? body.effort : undefined,
        },
        { text: prompt, images },
      )

      void refresh()

      json(res, 201, {
        sessionId: driver.sessionId,
        cwd,
        directoryCreated: created,
        trusted: trust.trusted,
        alreadyTrusted: trust.alreadyTrusted,
        status: driver.status,
      })
    } catch (err) {
      json(res, 500, { error: String(err) })
    }
    return
  }

  // Everything waiting on you across the fleet, which is what the index leads with.
  if (url.pathname === '/api/attention') {
    json(res, 200, attentionQueue(fleet.all(), heldDecisions()))
    return
  }

  if (url.pathname === '/api/usage/blocks') {
    json(res, 200, await blockUsage())
    return
  }

  if (url.pathname === '/api/drivers') {
    json(res, 200, { drivers: drivers.statuses() })
    return
  }

  if (await serveStatic(req, res)) return
  json(res, 404, { error: 'not found' })
}

/**
 * Answer requests, and never die of one.
 *
 * `node:http` does not await the handler, so anything it throws or rejects with would
 * otherwise be an unhandled rejection rather than a failed request — and this process is
 * driving `claude` children that a crash would orphan. No route is worth that, so every
 * unexpected failure becomes a 500 and the daemon carries on. A route that already began
 * its answer cannot be given a different status, so all that is left for one of those is
 * to stop writing.
 */
export function answerRequest(req: IncomingMessage, res: ServerResponse): void {
  void handleRequest(req, res).catch((err) => {
    console.error(`[aivis] ${req.method} ${req.url} failed:`, err)
    if (res.headersSent) {
      if (!res.writableEnded) res.end()
      return
    }
    json(res, 500, { error: 'internal error' })
  })
}

const server = createServer(answerRequest)

// A WebSocket handshake is not subject to the same-origin policy, and the first frame this
// server sends is the whole fleet — every title, path and transcript location. Browsers
// always send `Origin` on the handshake, so the same check that guards the HTTP routes is
// what keeps another tab from opening this socket. The server is exported so a test can run
// the Host/Origin table through the very `verifyClient` this socket was built with, rather
// than through a copy of it that could drift.
export const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: ({ req }: { req: IncomingMessage }) => sameOrigin(req.headers, config),
})

/**
 * Clients that have answered the ping sent on the previous sweep.
 *
 * A connection that dies without a TCP FIN — a sleeping laptop, a NAT timeout — fires
 * neither 'close' nor 'error' for a long time, so its socket sits in `clients` looking open
 * and collecting broadcasts nobody will read. A ping left unanswered for a whole period is
 * what tells that apart from a page that is merely idle, and idle is this dashboard's
 * normal state. The set is weak so that membership never keeps a closed socket alive.
 */
const responsive = new WeakSet<WebSocket>()

wss.on('connection', (socket) => {
  clients.add(socket)
  responsive.add(socket)
  const snapshot: ServerMessage = {
    kind: 'snapshot',
    sessions: fleet.all(),
    scannedAt: new Date().toISOString(),
  }
  socket.send(JSON.stringify(snapshot))
  socket.send(
    JSON.stringify({
      kind: 'attention',
      queue: attentionQueue(fleet.all(), heldDecisions()),
    } satisfies ServerMessage),
  )
  for (const status of drivers.statuses()) {
    socket.send(JSON.stringify({ kind: 'driver', status } satisfies ServerMessage))
  }
  socket.on('pong', () => responsive.add(socket))
  socket.on('close', () => clients.delete(socket))
  socket.on('error', () => clients.delete(socket))
})

const heartbeat = setInterval(() => {
  for (const client of clients) {
    if (!responsive.has(client)) {
      clients.delete(client)
      client.terminate()
      continue
    }
    // Cleared before the ping rather than after the answer, so a pong has to arrive within
    // this period to count for the next sweep.
    responsive.delete(client)
    if (client.readyState === client.OPEN) client.ping()
  }
}, HEARTBEAT_MS)
// A keepalive sweep is no reason to hold the process open.
heartbeat.unref()
wss.on('close', () => clearInterval(heartbeat))

async function main(): Promise<void> {
  if (!LOCAL_NAMES.has(config.host.toLowerCase())) {
    console.warn(
      `\n[aivis] WARNING: binding to ${config.host}, which is not loopback.\n` +
        `[aivis] aivis has no authentication. Anyone who can reach ${config.host}:${config.port} can read\n` +
        `[aivis] every prompt in every transcript, browse your filesystem, and start claude in any\n` +
        `[aivis] directory as you. Put it behind something that authenticates, or unset AIVIS_HOST.\n`,
    )
  }

  // The first scan reads every transcript in the store, which on a large one is the slowest
  // thing the daemon ever does. Binding ahead of it costs nothing and saves the whole wait: a
  // client that connects during the scan is sent an empty fleet and then all of it, since
  // every session counts as changed on the first pass and is broadcast when it finishes.
  server.listen(config.port, config.host, () => {
    console.log(`[aivis] http://${config.host}:${config.port}`)
  })

  console.log(`[aivis] indexing ${config.projectsDir}`)
  const started = Date.now()
  await refresh()
  console.log(`[aivis] indexed ${fleet.all().length} sessions in ${Date.now() - started}ms`)

  // Transcripts are appended constantly, so watch events drive refreshes and the timer
  // is a floor that also keeps time-dependent status and process liveness current.
  const watcher = chokidar.watch(config.projectsDir, {
    depth: 1,
    ignoreInitial: true,
    awaitWriteFinish: false,
  })
  let pending: NodeJS.Timeout | null = null
  const schedule = (): void => {
    if (pending) return
    pending = setTimeout(() => {
      pending = null
      void refresh()
    }, 400)
  }
  watcher.on('add', schedule).on('change', schedule).on('unlink', schedule)
  // chokidar reports a watch failure — the file descriptor budget running out, a directory
  // that stopped being readable — by emitting 'error', and an EventEmitter with no listener
  // for that throws it instead, which would end the daemon. Losing the watch is survivable:
  // the interval below re-reads the fleet regardless, just less promptly.
  watcher.on('error', (err) => console.error('[aivis] watcher error:', err))
  setInterval(() => void refresh(), config.refreshIntervalMs)
}

/**
 * Leave, taking every driven session with us.
 *
 * The `claude` children aivis drives read their work from a standard input this process
 * owns, so one that outlives the daemon is left running with nobody to answer it. Every
 * exit path this process can observe therefore goes through here, and a failure to stop
 * the drivers is logged rather than allowed to skip the exit.
 */
function shutdown(code: number): never {
  try {
    drivers.stopAll()
  } catch (err) {
    console.error('[aivis] could not stop every driven session:', err)
  }
  process.exit(code)
}

/**
 * The signals that mean "leave", each of which would otherwise end the process with no JS
 * run at all and orphan every driven `claude`.
 *
 * `SIGHUP` is the one worth naming: Node's default action for it is to terminate, and it is
 * what the terminal sends to its whole foreground process group when the window is closed.
 * Closing the terminal that `npm start` or `npm run dev` is running in is an ordinary way to
 * end aivis, so without a handler that ordinary ending is the one that leaves children
 * behind. `SIGKILL` cannot be caught by anything, which is the limit of this guarantee.
 */
const EXIT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

/**
 * Whether this module is the program, rather than something that imported it.
 *
 * Everything above is a request handler, and a handler is only worth having if a test can
 * drive it. Importing this file used to mean binding the port, starting a filesystem
 * watcher and installing an `uncaughtException` handler that calls `process.exit`, so the
 * routes, the percent-decoding and the media-type gates could only be checked by grepping
 * this file's own source — which passes just as happily when the check is commented out.
 * Guarding the start-up here is what lets `test/index.test.ts` import the real handler and
 * the real WebSocket options and send requests through them, while `tsx server/index.ts`
 * behaves exactly as before. Both sides are resolved through `realpath` so that a symlinked
 * checkout — or `/tmp` on macOS, which is a link to `/private/tmp` — still compares equal.
 */
function isEntrypoint(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(path.resolve(entry)) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

/**
 * Install the process-wide handlers and begin serving.
 *
 * These are deliberately not run on import: a test that imported this file would otherwise
 * inherit an `uncaughtException` handler that exits the process, which turns a failing
 * assertion into a silently green run.
 */
function start(): void {
  for (const signal of EXIT_SIGNALS) {
    process.on(signal, () => shutdown(0))
  }

  // The two handlers below are deliberately asymmetric, because the two failures say
  // different things about the process. An uncaught exception unwound something mid-way and
  // nothing here knows what was left half-done, so continuing to serve would mean serving
  // from an unknown state: it stops the children and leaves, loudly. An unhandled rejection
  // is a promise nobody awaited, and now that every request is answered inside a catch of its
  // own the ones left are peripheral — a write to a connection the browser already dropped,
  // say — which tells us nothing about the health of anything else. Those are logged and
  // survived, because taking the whole fleet down over one of them costs far more than it
  // saves.
  process.on('uncaughtException', (err) => {
    console.error('[aivis] uncaught exception, stopping driven sessions and exiting:', err)
    shutdown(1)
  })

  process.on('unhandledRejection', (err) => {
    console.error('[aivis] unhandled rejection:', err)
  })

  // A daemon that failed to start is not one to leave half-running: the rejection handler
  // above would otherwise log it and let the process sit there listening to nothing.
  main().catch((err) => {
    console.error('[aivis] failed to start:', err)
    shutdown(1)
  })
}

if (isEntrypoint()) start()
