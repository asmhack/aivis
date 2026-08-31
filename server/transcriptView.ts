import { createReadStream, promises as fs } from 'node:fs'
import { createInterface } from 'node:readline'
import type { EntryImage, ToolCall, TranscriptEntry, TranscriptPage } from '../shared/types.ts'
import { readBashOutput, readBashRuns } from '../shared/bash.ts'
import { isSynthetic } from './synthetic.ts'

const MAX_RESULT_CHARS = 4000

interface RawRecord {
  type?: string
  subtype?: string
  /** System records carry their text here rather than in a message. */
  content?: unknown
  uuid?: string
  timestamp?: string
  isSidechain?: boolean
  isMeta?: boolean
  message?: {
    role?: string
    model?: string
    content?: unknown
  }
  /**
   * What a session writes when something is pushed into it over its message socket. The
   * prompt is held here rather than in a user record, and `source_uuid` is the id the
   * sender generated, echoed back — which is the only delivery receipt the socket offers.
   */
  attachment?: {
    type?: string
    /**
     * A plain string for a typed message, but a content-block array when the message
     * carried an image alongside its text.
     */
    prompt?: unknown
    source_uuid?: string
    origin?: { kind?: string; from?: string }
  }
}

interface Block {
  type?: string
  source?: { type?: string; media_type?: string; data?: string }
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

function blocks(content: unknown): Block[] {
  return Array.isArray(content) ? (content as Block[]) : []
}

/** Flatten a tool result, which may be plain text or a list of content blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  return blocks(content)
    .map((b) => (typeof b.text === 'string' ? b.text : b.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n')
}

/** The text of a queued command, which may be a bare string or a block array. */
function promptText(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt
  return blocks(prompt)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

/**
 * The images in a message body, referenced by position rather than inlined.
 *
 * The index is the block's place in the record's own content array, not its place among
 * the images, because that is what `readImage` looks the bytes up by: a message whose
 * picture came before its text is the ordinary shape, since a screenshot is usually the
 * subject the words refer to.
 */
function imagesIn(content: unknown): EntryImage[] {
  return blocks(content)
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.type === 'image' && block.source?.data)
    .map(({ block, index }) => ({ index, mediaType: block.source?.media_type ?? 'image/png' }))
}

/**
 * Read a session's whole conversation.
 *
 * This used to read only the last few megabytes, which was the wrong measure entirely: a
 * transcript is large because screenshots are inlined as base64, not because the
 * conversation is long, and the images are dropped here rather than sent. The largest
 * transcript on a machine can be a hundred megabytes and still be a thousand entries that
 * serialize to two, so the whole file is read and everything derived from it — the tool
 * list, the files a session touched — describes the session rather than its last page.
 *
 * The file is streamed a line at a time so its size bounds the work but never the memory:
 * slurping a hundred megabytes of UTF-8 into one string costs twice that in a JS string,
 * for a payload that ends up a fiftieth of the size.
 *
 * Streaming bounds one read, not several: the entries kept from a large file are the
 * biggest thing a request here holds, so only a couple of these run at once and the rest
 * queue. The gate is their own — the image scans below have a separate one — so a page's
 * pictures and the conversation they belong to never wait on each other.
 */
export async function readTranscript(
  filePath: string,
  sessionId: string,
  limit: number,
): Promise<TranscriptPage> {
  return withTranscriptSlot(() => readWholeTranscript(filePath, sessionId, limit))
}

async function readWholeTranscript(
  filePath: string,
  sessionId: string,
  limit: number,
): Promise<TranscriptPage> {
  const stat = await fs.stat(filePath)

  const entries: TranscriptEntry[] = []
  const toolIndex = new Map<string, ToolCall>()
  /**
   * The `!` run whose output has not been read yet.
   *
   * A terminal records a run as two records — the command, then what it printed — so the
   * second has to find the first. Holding the entry itself rather than folding onto whatever
   * happens to be last is what keeps a stray output record from overwriting a run that
   * already has its output, which is every run aivis writes: those carry both halves in one
   * record and are never open.
   */
  let openBash: Extract<TranscriptEntry, { kind: 'bash' }> | null = null

  const lines = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  for await (const line of lines) {
    if (!line.trim()) continue
    let rec: RawRecord
    try {
      rec = JSON.parse(line) as RawRecord
    } catch {
      continue
    }
    const at = rec.timestamp ?? ''
    const uuid = rec.uuid ?? `${entries.length}`
    const sidechain = rec.isSidechain === true

    if (rec.type === 'assistant' && rec.message) {
      const content = blocks(rec.message.content)
      const body = content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n')
        .trim()
      const thinking = content
        .filter((b) => b.type === 'thinking')
        .map((b) => b.thinking ?? '')
        .join('\n')
        .trim()

      if (body || thinking) {
        entries.push({
          kind: 'assistant',
          uuid,
          at,
          text: body,
          thinking,
          model: rec.message.model ?? null,
          sidechain,
        })
      }

      for (const block of content) {
        if (block.type !== 'tool_use' || !block.id || !block.name) continue
        const call: ToolCall = {
          id: block.id,
          name: block.name,
          input: block.input ?? {},
          result: null,
          isError: false,
          resultTruncated: false,
        }
        toolIndex.set(block.id, call)
        entries.push({ kind: 'tool', uuid: `${uuid}:${block.id}`, at, sidechain, call })
      }
      continue
    }

    // What the command printed arrives as its own record, after the command itself, so it
    // is folded back onto the entry that ran it rather than shown adrift.
    if (rec.type === 'system' && rec.subtype === 'local_command') {
      const raw = typeof rec.content === 'string' ? rec.content : ''
      const out = raw.match(/<local-command-stdout>([\s\S]*)<\/local-command-stdout>/)?.[1] ?? ''
      const last = entries[entries.length - 1]
      if (last?.kind === 'command') last.output = out.trim()
      continue
    }

    if (rec.type === 'attachment' && rec.attachment?.type === 'queued_command') {
      const text = promptText(rec.attachment.prompt).trim()
      // A message can be a picture and nothing else — a screenshot pasted into the composer
      // with no words — and this record is where one lands whenever the session took it
      // mid-turn. Reading only the text dropped it from the very page that sent it.
      const images = imagesIn(rec.attachment.prompt)
      // Same reason as the user branch below: a task notification arrives here too, and a
      // notification is not a message anybody sent. It never carries a picture, so the
      // filter still reads the text.
      if (isSynthetic(text) || (!text && images.length === 0)) continue
      entries.push({
        kind: 'queued',
        uuid,
        at,
        text,
        images,
        from: rec.attachment.origin?.from ?? 'unknown',
        sourceUuid: rec.attachment.source_uuid ?? null,
      })
      continue
    }

    if (rec.type === 'user' && rec.message) {
      const content = rec.message.content
      const results = blocks(content).filter((b) => b.type === 'tool_result')
      if (results.length > 0) {
        for (const block of results) {
          const call = block.tool_use_id ? toolIndex.get(block.tool_use_id) : undefined
          if (!call) continue
          const full = resultText(block.content)
          call.result = full.length > MAX_RESULT_CHARS ? full.slice(0, MAX_RESULT_CHARS) : full
          call.resultTruncated = full.length > MAX_RESULT_CHARS
          call.isError = block.is_error === true
        }
        continue
      }
      const parts = blocks(content)
      let body = typeof content === 'string' ? content : parts.map((b) => b.text ?? '').join('\n')

      // A slash command is filed as a synthetic user turn. It is read before the synthetic
      // filter below, which would otherwise drop it along with the caveat block that
      // precedes it, leaving a command run from aivis with nothing to show for itself.
      const name = body.match(/<command-name>\/?([^<]+)<\/command-name>/)
      if (name) {
        const args = body.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim() ?? ''
        entries.push({
          kind: 'command',
          uuid,
          at,
          text: `/${name[1]?.trim() ?? ''}${args ? ` ${args}` : ''}`,
          output: '',
        })
        continue
      }

      // A `!` bash line, read before the synthetic filter for the same reason the slash
      // command above it is: the wrapper says truthfully that this is not a prompt, but the
      // filter turns that into nothing at all, and a run started from this page would then
      // leave no trace on it.
      //
      // Two shapes arrive. A terminal writes the command alone and its output as the next
      // record. aivis writes both halves together and, because it sends them in front of a
      // real message rather than on their own, may follow them with the text you typed —
      // which is why what is left over is read on as a message instead of being dropped.
      const bash = readBashRuns(body)
      if (bash) {
        openBash = null
        for (const [index, run] of bash.runs.entries()) {
          const entry: Extract<TranscriptEntry, { kind: 'bash' }> = {
            kind: 'bash',
            uuid: `${uuid}:bash:${index}`,
            at,
            command: run.command,
            stdout: run.stdout,
            stderr: run.stderr,
            // A transcript records the two streams and nothing else, so the status a run
            // exited with is genuinely unknown here rather than zero.
            exitCode: null,
            running: false,
            pending: false,
          }
          entries.push(entry)
          if (!run.complete) openBash = entry
        }
        body = bash.rest
      } else if (openBash) {
        const output = readBashOutput(body)
        if (output) {
          openBash.stdout = output.stdout
          openBash.stderr = output.stderr
          openBash = null
          continue
        }
      }
      // Images are referenced by position rather than inlined, so a page of the
      // conversation stays small enough to send even when it carries screenshots.
      const images = imagesIn(content)
      if (rec.isMeta || sidechain) continue
      if (!body.trim() && images.length === 0) continue
      if (isSynthetic(body)) continue
      entries.push({ kind: 'user', uuid, at, text: body.trim(), images })
    }
  }

  return {
    sessionId,
    entries: entries.slice(-limit),
    // Only an entry count can truncate now, and `limit` is set well above what a real
    // session reaches, so this is a backstop rather than something you meet in practice.
    truncated: entries.length > limit,
    bytesRead: stat.size,
    fileSize: stat.size,
  }
}

/**
 * How many reads of a transcript may run at once.
 *
 * A conversation page asks for every image it holds as it paints, and each of those
 * requests walks the same transcript looking for one record. Streaming took the window out
 * of that cost but not the record, and the record is the expensive part: an image lives
 * inline as base64, so at the moment a scan meets its picture it is holding that picture
 * three times over — once as the line `tailLines` just yielded, again as the string
 * `JSON.parse` lifts out of it, and a third time as the bytes decoded from that. A six
 * megabyte screenshot is some twenty megabytes live, which is small enough for one scan and
 * not for a page of them arriving at once. The gate is what bounds that by its own width
 * instead of by however many pictures the page happens to show.
 *
 * Queueing costs less than it looks. The decoding is all on the one thread, so letting the
 * scans overlap does not finish them any sooner — it delays every picture to roughly when
 * the last one would have landed anyway, where queueing lets the first arrive after a
 * single scan. It does cost a store slow enough to be waiting on the disk rather than on
 * the CPU, where overlapping the waits would genuinely help; that is also the case where
 * running every request at once is likeliest to end the daemon, so the gate keeps its
 * width. Nothing queues that is not already an open request, so the queue is as deep as
 * the connections the browser has, not deeper.
 *
 * The whole-file read the conversation itself comes from is gated separately rather than
 * sharing those slots: the two cost different things — a scan holds one record at a time,
 * a whole read accumulates every entry it keeps — and on one page load they arrive in that
 * order, so a burst of pictures must not leave the conversation queued behind them. What
 * the daemon holds at once is therefore bounded by the width of each gate rather than by
 * how many requests arrive, which is not the same as flat; and what a route sends after
 * its scan returns — the local file `/localfile` opens once the mention is confirmed — is
 * outside both gates entirely.
 */
const MAX_CONCURRENT_SCANS = 2
const MAX_CONCURRENT_TRANSCRIPT_READS = 2

/**
 * Build a gate that lets `limit` calls run at once and queues the rest in arrival order.
 *
 * Nothing running inside a gate may call anything that takes the same gate: the inner call
 * would wait for a slot the outer call is still holding, and once `limit` callers have
 * nested, that deadlock is silent — there is nothing here that could notice it. Both gates
 * below are taken at the top of a request and given up before it answers, which is what
 * keeps that true.
 */
function gate(limit: number): <T>(work: () => Promise<T>) => Promise<T> {
  let running = 0
  const waiting: Array<() => void> = []
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (running < limit) running++
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      return await work()
    } finally {
      // The slot is passed straight to the next waiter rather than released and taken again,
      // which is what stops a fresh caller slipping into it before that waiter has resumed.
      const next = waiting.shift()
      if (next) next()
      else running--
    }
  }
}

const withScanSlot = gate(MAX_CONCURRENT_SCANS)
const withTranscriptSlot = gate(MAX_CONCURRENT_TRANSCRIPT_READS)

/**
 * Walk the tail of a transcript a line at a time.
 *
 * The window is the one the caller asked for, but it is streamed rather than pulled in
 * whole: reading a 64MB slice costs that buffer and then as much again for the string it
 * is decoded into, so one page of screenshots could ask the daemon for a gigabyte of
 * transient memory to serve a handful of pictures. Streaming holds one record at a time.
 *
 * The window almost always opens mid-record, so the first line is whatever it cut in
 * half. Both callers tolerate that, exactly as they tolerated the old byte slice: a
 * truncated record fails to parse, and a truncated path fails to match.
 */
async function* tailLines(filePath: string, maxBytes: number): AsyncGenerator<string> {
  const stat = await fs.stat(filePath)
  const stream = createReadStream(filePath, {
    encoding: 'utf8',
    start: Math.max(0, stat.size - maxBytes),
  })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) yield line
  } finally {
    // A caller that has found what it came for stops iterating, which lands here rather
    // than at the end of the file, so the handle is closed now rather than at some later
    // collection of the stream.
    lines.close()
    stream.destroy()
  }
}

/** An image pulled back out of a transcript record. */
export interface StoredImage {
  mediaType: string
  bytes: Buffer
}

/**
 * Images already found, so that the same picture is never searched for twice.
 *
 * A scan is cheap in memory but not in time — it walks the transcript from the start of
 * the window until it meets the record — and the gate above hands those walks out two at a
 * time, so without this a page of screenshots pays for every one of them in series. The
 * cache is read before a slot is asked for, so a hit never queues behind anything.
 *
 * The key needs no mtime. A transcript is only appended to and a record's uuid is written
 * once, so the image at (file, uuid, index) is that same image for as long as the file is
 * there — and leaving mtime out is what makes the cache useful at all for a live session,
 * whose transcript is being appended to between one image request and the next. Only a
 * hit is kept: a miss is not a fact about the file, since the record may be older than the
 * window this search was given and found by a wider one later.
 *
 * The bound is bytes rather than entries because the entries are screenshots, and a page
 * of them would otherwise park in the cache more than the gate was added to keep out.
 */
const MAX_CACHED_IMAGE_BYTES = 24 * 1024 * 1024
const imageCache = new Map<string, StoredImage>()
let cachedImageBytes = 0

/**
 * One key out of three parts, joined by a byte a path cannot contain.
 *
 * The uuid arrives as a query parameter, so it is whatever the caller sent — but the index
 * closes the key and is a number, so the key still reads back one way only, and two
 * different records cannot be made to name the same entry.
 */
function imageKey(filePath: string, uuid: string, index: number): string {
  return `${filePath}\u0000${uuid}\u0000${index}`
}

function recallImage(key: string): StoredImage | undefined {
  const hit = imageCache.get(key)
  // Re-inserting moves the entry to the end of the map, so what falls out below is
  // whatever has gone longest unlooked-at rather than whatever happened to be read first.
  if (hit) {
    imageCache.delete(key)
    imageCache.set(key, hit)
  }
  return hit
}

function rememberImage(key: string, image: StoredImage): void {
  // One picture bigger than the whole budget would evict everything and still not fit.
  if (image.bytes.length > MAX_CACHED_IMAGE_BYTES) return
  const previous = imageCache.get(key)
  if (previous) cachedImageBytes -= previous.bytes.length
  imageCache.delete(key)
  imageCache.set(key, image)
  cachedImageBytes += image.bytes.length
  for (const [oldest, evicted] of imageCache) {
    if (cachedImageBytes <= MAX_CACHED_IMAGE_BYTES) break
    imageCache.delete(oldest)
    cachedImageBytes -= evicted.bytes.length
  }
}

/**
 * Paths a transcript has already been shown to mention.
 *
 * The same reasoning as the image cache, and the same one-sided answer: a file that is
 * only appended to can gain a mention but never lose one, so a `true` stays true, while a
 * `false` says only that the path was absent from the window searched at the time. Nothing
 * is relaxed by remembering it — the path still had to appear in this very session's
 * transcript for the entry to exist, and the entry is keyed by that transcript.
 */
const MAX_CACHED_MENTIONS = 256
const mentionCache = new Set<string>()

function recallMention(key: string): boolean {
  if (!mentionCache.has(key)) return false
  mentionCache.delete(key)
  mentionCache.add(key)
  return true
}

function rememberMention(key: string): void {
  mentionCache.delete(key)
  mentionCache.add(key)
  for (const oldest of mentionCache) {
    if (mentionCache.size <= MAX_CACHED_MENTIONS) break
    mentionCache.delete(oldest)
  }
}

/**
 * Read one image out of a transcript by the uuid of the record that carries it.
 *
 * Images live inline as base64 inside the record, which is why they are served through
 * this rather than sent with the conversation: a single screenshot would otherwise
 * dominate every page of the transcript.
 *
 * The search covers the last `maxBytes` of the file, which is narrower than what the
 * conversation view lists — that reads the whole transcript — so a record older than the
 * window is drawn with an image this cannot find, and the route answers 404 for it. The
 * window is the caller's to choose and no longer bounds memory now that the read is
 * streamed: it bounds only how long a miss takes.
 */
export async function readImage(
  filePath: string,
  uuid: string,
  index: number,
  maxBytes: number,
): Promise<StoredImage | null> {
  const key = imageKey(filePath, uuid, index)
  const cached = recallImage(key)
  if (cached) return cached
  const found = await withScanSlot(async () => {
    for await (const line of tailLines(filePath, maxBytes)) {
      if (!line.includes(uuid)) continue
      let rec: RawRecord
      try {
        rec = JSON.parse(line) as RawRecord
      } catch {
        continue
      }
      if (rec.uuid !== uuid) continue
      // A message pushed into a session keeps its blocks under the attachment rather than
      // in a message of its own, and the picture sent with one is stored there too.
      const block = blocks(rec.message?.content)[index] ?? blocks(rec.attachment?.prompt)[index]
      const data = block?.source?.data
      if (!data) return null
      return {
        mediaType: block.source?.media_type ?? 'image/png',
        bytes: Buffer.from(data, 'base64'),
      }
    }
    return null
  })
  if (found) rememberImage(key, found)
  return found
}

/**
 * Image types worth serving out of the filesystem for a transcript.
 *
 * SVG is deliberately absent and has to stay absent. An SVG is a document rather than a
 * picture — a browser runs the `<script>` inside one when it is opened at the top level,
 * and the conversation view renders every local image as a link you can click — so
 * serving one from this origin would give a file the session was talked into writing full
 * same-origin reach into the aivis API, which needs no credential to drive a session. A
 * prompt injection only has to get the model to write the file and mention its path. With
 * no mapping here `localImageType` returns null for it and the route answers 415.
 */
const LOCAL_IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

export function localImageType(filePath: string): string | null {
  const dot = filePath.lastIndexOf('.')
  return dot === -1 ? null : (LOCAL_IMAGE_TYPES[filePath.slice(dot).toLowerCase()] ?? null)
}

/**
 * Confirm a transcript actually mentions a path before its bytes are served.
 *
 * Messages often link to a screenshot by absolute path, which a browser cannot open
 * itself. Serving those files turns the link into the picture, but an endpoint that
 * reads any path on request is a poor thing to leave listening — so a path is only
 * served when the conversation being viewed refers to it.
 *
 * The needle is looked for one line at a time, so a path carrying a literal newline can
 * no longer match. Nothing is lost by that: a transcript writes a path inside a JSON
 * string, where a newline is escaped rather than left literal, and a path that fails to
 * match is simply not served.
 */
export async function transcriptMentions(
  filePath: string,
  needle: string,
  maxBytes: number,
): Promise<boolean> {
  const key = `${filePath}\u0000${needle}`
  if (recallMention(key)) return true
  const mentioned = await withScanSlot(async () => {
    for await (const line of tailLines(filePath, maxBytes)) {
      if (line.includes(needle)) return true
    }
    return false
  })
  if (mentioned) rememberMention(key)
  return mentioned
}
