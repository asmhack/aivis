import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ActivitySummary, AskSummary, BackgroundTask, Session, TokenUsage } from '../shared/types.ts'
import { recordUsage } from './blocks.ts'
import { INTERRUPTED, isSynthetic } from './synthetic.ts'
import { finishedTaskIds, isBackgroundCall } from './tasks.ts'

/** One record in a Claude Code transcript file. Only the fields aivis reads are typed. */
interface TranscriptRecord {
  type?: string
  subtype?: string
  sessionId?: string
  cwd?: string
  gitBranch?: string
  timestamp?: string
  isSidechain?: boolean
  isMeta?: boolean
  version?: string
  permissionMode?: string
  /** Effort the turn was run at, recorded on each assistant record. */
  effort?: string
  summary?: string
  message?: {
    role?: string
    model?: string
    stop_reason?: string
    content?: unknown
    usage?: Record<string, number>
  }
  /** What a session writes when a message is pushed into it over its message socket. */
  attachment?: {
    type?: string
    /**
     * A plain string for a typed message, but a content-block array when the message
     * carried an image alongside its text, so it is read through `textOf` like any
     * other message body rather than treated as a string.
     */
    prompt?: unknown
  }
}

interface ContentBlock {
  type?: string
  text?: string
  name?: string
  id?: string
  tool_use_id?: string
  input?: Record<string, unknown>
}

/** The tool Claude Code calls to put a multiple-choice question to you. */
const ASK_TOOL = 'AskUserQuestion'

/**
 * Reduce an `AskUserQuestion` call to the line the index draws.
 *
 * Reading this from the transcript rather than from the driver is what lets aivis report a
 * question asked by a session running in a terminal, which it has no other channel into.
 * It says a question is open; answering one is a separate capability that only a session
 * aivis drives has.
 */
function summarizeAsk(block: ContentBlock, at: string): AskSummary | null {
  if (!block.id) return null
  const raw = block.input?.questions
  const questions = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : []
  const first = questions[0]
  const question = typeof first?.question === 'string' ? first.question : ''
  const header = typeof first?.header === 'string' && first.header ? first.header : 'Question'
  if (!question) return null
  return { toolUseId: block.id, header, question, count: questions.length, at }
}

/** Mutable state accumulated while reading a transcript from start to end. */
interface Accumulator {
  sessionId: string | null
  cwd: string | null
  gitBranch: string | null
  version: string | null
  permissionMode: string | null
  model: string | null
  effort: string | null
  title: string | null
  summary: string | null
  startedAt: string | null
  lastActivityAt: string | null
  userTurns: number
  assistantTurns: number
  toolCalls: number
  subagentTurns: number
  tokens: TokenUsage
  lastActivity: ActivitySummary | null
  /** Shape of the most recent meaningful record, used to derive status. */
  lastShape: 'assistant-tool' | 'assistant-end' | 'tool-result' | 'user-prompt' | null
  /**
   * The question the session is holding on, or null when it is not holding on one.
   *
   * A question is open from the tool call that asked it until its result lands. That is a
   * fact about the transcript rather than an inference from silence, which is what makes
   * it worth more than the `stalled` it would otherwise be reported as.
   */
  ask: AskSummary | null
  /**
   * Background tasks started and not yet reported finished, keyed by their tool call.
   *
   * A map rather than a list because the closing record names the call it belongs to, so
   * finishing one is a delete. Insertion order is preserved, which is launch order.
   */
  tasks: Map<string, BackgroundTask>
  /**
   * Tool calls counted into the minute they happened in, keyed by epoch minute.
   *
   * Only the recent past is kept, because that is all the sparkline draws; a transcript
   * read from the beginning would otherwise carry a bucket for every minute of its life.
   */
  pulse: Map<number, number>
}

/** Per-file reader state, so each change event only parses newly appended bytes. */
interface FileState {
  offset: number
  /**
   * The tail of the last read, which stopped before the newline that would end its record.
   *
   * Raw bytes rather than decoded text, because a read ends wherever the file happened to
   * end. A multi-byte character straddling that boundary decodes to a replacement character
   * on each side of it, and once decoded the two halves can never be joined back up — the
   * record still parses as JSON, so the loss lands silently in a title or a tool detail.
   */
  partial: Buffer
  acc: Accumulator
  /** True when the first read skipped the middle of an oversized file. */
  sampled: boolean
  /** Size of the file as of the last read. */
  size: number
}

function emptyAccumulator(): Accumulator {
  return {
    sessionId: null,
    cwd: null,
    gitBranch: null,
    version: null,
    permissionMode: null,
    model: null,
    effort: null,
    title: null,
    summary: null,
    startedAt: null,
    lastActivityAt: null,
    userTurns: 0,
    assistantTurns: 0,
    toolCalls: 0,
    subagentTurns: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, contextWindow: 0 },
    lastActivity: null,
    lastShape: null,
    ask: null,
    tasks: new Map(),
    pulse: new Map(),
  }
}

/** Text that Claude Code injects into the transcript rather than the user typing it. */
function blocksOf(content: unknown): ContentBlock[] {
  return Array.isArray(content) ? (content as ContentBlock[]) : []
}

/** Extract plain text from a message body that may be a string or a block array. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  return blocksOf(content)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : clean.slice(0, max - 1) + '…'
}

/**
 * Summarize a tool call in one line. Each tool carries its meaning in a different
 * input field, so the interesting field is picked per tool and everything else
 * falls back to the first string input.
 */
function describeTool(name: string, input: Record<string, unknown> | undefined, cwd: string | null): string {
  const get = (key: string): string | null => {
    const v = input?.[key]
    return typeof v === 'string' ? v : null
  }
  /**
   * Shorten a path that is inside the session's directory, which is the same for every row.
   *
   * The prefix has to be followed by a separator to count. A sibling checkout — `…/acme-old`
   * beside `…/acme` — starts with the same characters without being inside it, and slicing
   * the prefix off anyway turned `…/checkout-api-old/app/post.py` into `old/app/post.py`: a
   * path that reads as relative to this session and points at nothing.
   */
  const relative = (p: string): string => {
    if (!cwd || !p.startsWith(cwd)) return p
    const rest = p.slice(cwd.length)
    if (rest[0] !== '/' && rest[0] !== '\\') return p
    return rest.slice(1) || p
  }

  switch (name) {
    case 'Bash':
      return truncate(get('command') ?? '', 90)
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit': {
      const f = get('file_path')
      return f ? truncate(relative(f), 90) : ''
    }
    case 'Grep':
      return truncate(get('pattern') ?? '', 90)
    case 'Glob':
      return truncate(get('pattern') ?? '', 90)
    case 'Agent':
    case 'Task':
      return truncate(get('description') ?? get('prompt') ?? '', 90)
    case 'WebFetch':
      return truncate(get('url') ?? '', 90)
    case 'WebSearch':
      return truncate(get('query') ?? '', 90)
    case 'Skill':
      return truncate(get('skill') ?? '', 90)
    default: {
      for (const value of Object.values(input ?? {})) {
        if (typeof value === 'string' && value.length > 0) return truncate(value, 90)
      }
      return ''
    }
  }
}

const MINUTE_MS = 60_000

/** How many minutes of tool activity a session carries, which is what the sparkline draws. */
const PULSE_MINUTES = 15

/** Fold a turn's tool calls into the minute they were made in, dropping older minutes. */
function recordPulse(acc: Accumulator, timestamp: string | null, calls: number): void {
  const at = timestamp ? new Date(timestamp).getTime() : NaN
  if (!Number.isFinite(at)) return
  const minute = Math.floor(at / MINUTE_MS)
  acc.pulse.set(minute, (acc.pulse.get(minute) ?? 0) + calls)
  if (acc.pulse.size <= PULSE_MINUTES * 4) return
  const oldest = Math.floor(Date.now() / MINUTE_MS) - PULSE_MINUTES
  for (const key of acc.pulse.keys()) {
    if (key < oldest) acc.pulse.delete(key)
  }
}

/** The last `PULSE_MINUTES` minutes of tool activity, oldest first and ending at now. */
function pulseOf(acc: Accumulator): number[] {
  const now = Math.floor(Date.now() / MINUTE_MS)
  const bars: number[] = []
  for (let back = PULSE_MINUTES - 1; back >= 0; back -= 1) bars.push(acc.pulse.get(now - back) ?? 0)
  return bars
}

/**
 * A header field, or null when the record does not carry it as a non-empty string.
 *
 * `TranscriptRecord` describes what Claude Code writes; it is an assertion about the output
 * of `JSON.parse` rather than a check of it, and the file it parses is one that anything on
 * the machine can append to. A line carrying `"cwd": 1234` therefore used to put a number
 * where every later reader expects a path — and the throw that follows lands in the fleet's
 * scan rather than in the parse, which `applyLines` guards, so one hand-written line stopped
 * every session on the machine from being read. Taking the fields through here is what makes
 * the accumulator's types true, so nothing downstream has to re-check them.
 */
function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function applyRecord(acc: Accumulator, rec: TranscriptRecord): void {
  if (!acc.sessionId) acc.sessionId = str(rec.sessionId)
  acc.cwd = str(rec.cwd) ?? acc.cwd
  acc.gitBranch = str(rec.gitBranch) ?? acc.gitBranch
  acc.version = str(rec.version) ?? acc.version
  acc.permissionMode = str(rec.permissionMode) ?? acc.permissionMode
  if (rec.type === 'summary' && typeof rec.summary === 'string' && !acc.summary) {
    acc.summary = rec.summary
  }

  const ts = str(rec.timestamp)
  if (ts) {
    if (!acc.startedAt) acc.startedAt = ts
    acc.lastActivityAt = ts
  }

  const sidechain = rec.isSidechain === true

  if (rec.type === 'assistant' && rec.message) {
    if (sidechain) acc.subagentTurns += 1
    else acc.assistantTurns += 1
    // Only the main thread's model and effort are the session's. A subagent routinely runs
    // a smaller model at a lower effort, and reading either back would report the session
    // as having dropped to whatever its last agent happened to be dispatched at.
    if (!sidechain) acc.model = str(rec.message.model) ?? acc.model
    if (!sidechain && typeof rec.effort === 'string') acc.effort = rec.effort

    const usage = rec.message.usage
    if (usage) {
      const input = usage.input_tokens ?? 0
      const output = usage.output_tokens ?? 0
      const cacheRead = usage.cache_read_input_tokens ?? 0
      const cacheCreation = usage.cache_creation_input_tokens ?? 0
      acc.tokens.input += input
      acc.tokens.output += output
      acc.tokens.cacheRead += cacheRead
      acc.tokens.cacheCreation += cacheCreation
      if (!sidechain) acc.tokens.contextWindow = input + cacheRead + cacheCreation
      // Rate-limit blocks are account-wide, so subagent turns count too.
      recordUsage(ts, input + output + cacheRead + cacheCreation)
    }

    const toolBlocks = blocksOf(rec.message.content).filter((b) => b.type === 'tool_use')
    if (toolBlocks.length > 0) {
      acc.toolCalls += toolBlocks.length
      // Subagent calls count too: a session running twenty agents is busy, whatever its
      // own thread is doing between them.
      recordPulse(acc, ts, toolBlocks.length)
      // Work handed off to run outside this turn. The turn carries on without it, so the
      // only record that it is happening is this call and the notice that ends it.
      for (const block of toolBlocks) {
        if (!block.id || !block.name) continue
        if (!isBackgroundCall(block.name, block.input)) continue
        acc.tasks.set(block.id, {
          toolUseId: block.id,
          tool: block.name,
          detail: describeTool(block.name, block.input, acc.cwd) || null,
          at: ts ?? acc.lastActivityAt ?? new Date().toISOString(),
        })
      }
      const last = toolBlocks[toolBlocks.length - 1]
      if (last?.name) {
        acc.lastActivity = {
          tool: last.name,
          detail: describeTool(last.name, last.input, acc.cwd),
          at: ts ?? acc.lastActivityAt ?? new Date().toISOString(),
        }
      }
      if (!sidechain) {
        acc.lastShape = 'assistant-tool'
        // Only the main thread's question counts. A subagent has no user to ask, and one
        // surfacing here would put a question on the index that nobody can answer.
        const asking = toolBlocks.find((b) => b.name === ASK_TOOL)
        if (asking) {
          acc.ask = summarizeAsk(asking, ts ?? acc.lastActivityAt ?? new Date().toISOString())
        }
      }
    } else if (!sidechain) {
      acc.lastShape = rec.message.stop_reason === 'end_turn' ? 'assistant-end' : 'assistant-tool'
      // A turn that ended is not waiting on anything, whether the question was answered
      // elsewhere or the turn was cut short before it could be.
      if (acc.lastShape === 'assistant-end') acc.ask = null
    }
    return
  }

  // A message pushed in over the session's socket, which is how anything sent from aivis
  // reaches a session running in a terminal. It is a prompt somebody made, so it counts as
  // one, even though Claude Code files it as its own kind of record rather than a user turn.
  if (rec.type === 'attachment' && rec.attachment?.type === 'queued_command') {
    const text = textOf(rec.attachment.prompt).trim()
    for (const id of finishedTaskIds(text)) acc.tasks.delete(id)
    // A notification for a finished background task is delivered on this same channel, so
    // the wrapper check belongs here too. Without it the machine's own housekeeping is
    // counted as a turn somebody took, and titles the session when the head of a sampled
    // transcript held no prompt of its own.
    if (!text || isSynthetic(text)) return
    acc.userTurns += 1
    acc.lastShape = 'user-prompt'
    if (!acc.title) acc.title = truncate(text, 120)
    return
  }

  if (rec.type === 'user' && rec.message) {
    const blocks = blocksOf(rec.message.content)
    const isToolResult = blocks.some((b) => b.type === 'tool_result')
    if (isToolResult) {
      if (!sidechain) acc.lastShape = 'tool-result'
      // The answer arrives as the question's own result. Matching on the call's id rather
      // than clearing on any result at all is what keeps a question open while the other
      // tool calls of the same turn come back around it.
      if (acc.ask && blocks.some((b) => b.tool_use_id === acc.ask?.toolUseId)) acc.ask = null
      return
    }
    const text = textOf(rec.message.content)
    // A finished background task says so in a record that is about to be filtered out as
    // Claude Code's own bookkeeping, so it is read first. This is the only thing that ever
    // closes a task, which is why it is read even on a meta record.
    for (const id of finishedTaskIds(text)) acc.tasks.delete(id)
    // Stopping a turn writes a user record saying so, and nothing but the text itself marks
    // it as the machine's rather than yours. Counted as a prompt it inflated the turn count
    // and, worse, left the last shape at `user-prompt`, which reads as working and then ages
    // into `stalled` — so every session anybody had ever interrupted sat in the attention
    // queue for good. What an interrupt actually leaves is a session idle at its prompt,
    // which is the shape a finished turn has. `isSynthetic` now knows the marker too, so
    // that every other reader drops it; this branch is read ahead of that filter so the
    // shape it carries is taken first rather than dropped along with the record.
    if (text.trimStart().startsWith(INTERRUPTED)) {
      if (!sidechain) {
        acc.lastShape = 'assistant-end'
        // Whatever it was asking, the interrupt is what stopped it being asked.
        acc.ask = null
      }
      return
    }
    if (rec.isMeta || !text.trim() || isSynthetic(text)) return
    if (sidechain) return
    acc.userTurns += 1
    acc.lastShape = 'user-prompt'
    // Somebody typed. Whatever the session was asking, it is not asking it now — this is
    // the shape an interrupted question leaves behind, which has no result to match on.
    acc.ask = null
    if (!acc.title) acc.title = truncate(text, 120)
  }
}

/**
 * Whether a string is plausibly the id of a session.
 *
 * Claude Code names both the transcript and the `sessionId` field after a UUID, but nothing
 * stops another local process — or the model's own Write tool — from dropping a `.jsonl`
 * into the store that calls itself whatever it likes, and that string is what aivis puts in
 * the `claude --resume` line it offers to copy. The alphabet below is everything a real id
 * uses and nothing a shell reads as syntax, and the first character has to be alphanumeric
 * so an id can never arrive at a command line as a flag.
 */
export function isPlausibleSessionId(value: string): boolean {
  return /^[A-Za-z0-9][\w.-]{0,127}$/.test(value)
}

/**
 * The id a transcript names its session by: what its records say, falling back to the file's
 * own name, which is what Claude Code names a transcript after. Null when neither is
 * plausibly an id, which is the case a session must not be built from at all.
 */
function sessionIdOf(filePath: string, acc: Accumulator): string | null {
  const id = acc.sessionId ?? path.basename(filePath, '.jsonl')
  return isPlausibleSessionId(id) ? id : null
}

/** The byte that ends a record, which is where a decoded chunk may be cut. */
const NEWLINE = 0x0a

/** Shared empty carry-over: a partial line is replaced rather than written into. */
const NO_BYTES = Buffer.alloc(0)

/** Incrementally reads Claude Code transcripts and keeps a parsed view of each one. */
export class TranscriptIndex {
  private files = new Map<string, FileState>()

  /**
   * Files this index has given up on, so each one is reported once instead of on every pass.
   *
   * The scan comes back a few times a second and the reasons a file is dropped — it cannot
   * be opened, it cannot be read, it names a session id that is not one — do not clear
   * themselves, so a line per attempt would bury every other line in the log. An entry is
   * forgotten as soon as the file reads normally again, so a condition that is fixed and
   * then returns is reported afresh.
   */
  private skipped = new Set<string>()

  /**
   * Read whatever has been appended to `filePath` since the last call and fold it
   * into that file's accumulator. Returns null when the file holds no usable records.
   *
   * When the file has shrunk since the last read, which happens if a transcript is
   * rewritten, the accumulator is discarded and the file is parsed from the start.
   *
   * A file that cannot be read is dropped rather than thrown out of. The fleet scans every
   * transcript in one pass, so an exception raised here used to abort that pass in the
   * middle: one unreadable file — mode 000, owned by another user, a mount answering EIO —
   * froze the index, liveness and the attention queue for as long as it sat in the store.
   * Dropped means dropped from this pass, not forgotten: a file that read normally before
   * still returns what it read, because a transcript nobody can open right now is still a
   * session, and taking it out of the fleet takes the page that is open on it with it.
   */
  async ingest(filePath: string, fullParseMaxBytes = 4 * 1024 * 1024): Promise<Accumulator | null> {
    let stat
    try {
      stat = await fs.stat(filePath)
    } catch {
      this.forget(filePath)
      return null
    }

    let state = this.files.get(filePath)
    if (!state || stat.size < state.offset) {
      state = { offset: 0, partial: NO_BYTES, acc: emptyAccumulator(), sampled: false, size: 0 }
      this.files.set(filePath, state)
      if (stat.size > fullParseMaxBytes) {
        try {
          await this.sampleLargeFile(filePath, stat.size, state)
        } catch (err) {
          // Half a sample is not a state to carry on from, so it is dropped: a file that
          // becomes readable later is read from the beginning rather than from an offset
          // that no longer means anything.
          this.files.delete(filePath)
          return this.skip(filePath, err)
        }
      }
    }
    state.size = stat.size
    let failed = false
    if (stat.size > state.offset) {
      try {
        await this.readAppended(filePath, stat.size, state)
      } catch (err) {
        // What earlier passes read is still true, so the session keeps its last known state
        // rather than vanishing. Returning null here instead drops the file from the scan,
        // which the fleet reads as a session that has gone: it broadcasts a removal, the web
        // client deletes it, and the open page unmounts — losing whatever was typed into the
        // composer and where the conversation was scrolled to. One EMFILE burst does that to
        // every session at once, and the next pass brings them all back a second later. A
        // session that stops being readable stops moving instead, ages into `stalled` and
        // then `ended` on its own, and disappears properly when the file itself does, which
        // is the `fs.stat` path above. A file that was never readable still yields nothing,
        // because its accumulator has no activity in it.
        this.skip(filePath, err)
        failed = true
      }
    }

    // A session has to have an id before it can be one. Refusing the file here is what keeps
    // a hostile id out of the fleet altogether, rather than leaving every later place that
    // spends it — the resume command aivis offers to copy, above all — to quote it right.
    // A failed read is held to it too: it is the last thing a stale accumulator passes.
    if (!sessionIdOf(filePath, state.acc)) return this.skip(filePath, 'names a session id that is not one')

    if (!failed) this.skipped.delete(filePath)
    return state.acc.lastActivityAt ? state.acc : null
  }

  /** Drop a file from this pass, saying why the first time it happens. */
  private skip(filePath: string, reason: unknown): null {
    if (!this.skipped.has(filePath)) {
      this.skipped.add(filePath)
      console.error(`[aivis] skipping transcript ${filePath}: ${reason instanceof Error ? reason.message : reason}`)
    }
    return null
  }

  /**
   * Read the bytes appended since the last pass and fold whole lines out of them.
   *
   * A single read is not promised to return everything asked for: the file can be truncated
   * between the stat above and the read, and a network filesystem can come up short for its
   * own reasons. So only the bytes actually returned are decoded, the offset advances by
   * exactly that many, and the loop asks again for the rest. Decoding the whole buffer
   * instead handed the JSON parser whatever was left in that uninitialised memory, and
   * moving the offset to the file's size regardless skipped the missing bytes for good.
   */
  private async readAppended(filePath: string, size: number, state: FileState): Promise<void> {
    const handle = await fs.open(filePath, 'r')
    try {
      while (state.offset < size) {
        const buffer = Buffer.allocUnsafe(size - state.offset)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, state.offset)
        // Nothing more to give: the file shrank after it was measured. What is there now is
        // read on the next pass, which sees the smaller size and starts the file again.
        if (bytesRead <= 0) break
        state.offset += bytesRead
        this.consume(state, buffer.subarray(0, bytesRead))
      }
    } finally {
      await handle.close()
    }
  }

  /**
   * Fold the whole lines out of newly read bytes, carrying the unfinished last one forward.
   *
   * The split is made on the bytes rather than on decoded text, because the read ends at an
   * arbitrary byte: cutting a multi-byte character in half and decoding each half separately
   * turns it into two replacement characters, in a line that still parses as JSON.
   */
  private consume(state: FileState, bytes: Buffer): void {
    const pending = state.partial.length > 0 ? Buffer.concat([state.partial, bytes]) : bytes
    const end = pending.lastIndexOf(NEWLINE)
    // Both carries below are copies rather than views into the buffer that was just read,
    // which would hold the whole of it alive behind a line of a few hundred bytes.
    if (end < 0) {
      // Not one whole record yet, so there is nothing to parse: it waits for its newline.
      state.partial = Buffer.from(pending)
      return
    }
    state.partial = Buffer.from(pending.subarray(end + 1))
    this.applyLines(state.acc, pending.subarray(0, end).toString('utf8').split('\n'))
  }

  /**
   * Read only the beginning and end of a transcript that is too large to parse whole.
   *
   * The head supplies the session's opening prompt and start time; the tail supplies
   * current activity and status. The gap between them is skipped, so turn and token
   * counts become lower bounds and the session is flagged as sampled. The read offset
   * is left at the end of the file, so later appends are parsed normally and a live
   * session stays exact from this point on.
   */
  private async sampleLargeFile(filePath: string, size: number, state: FileState): Promise<void> {
    const WINDOW = 512 * 1024
    const handle = await fs.open(filePath, 'r')
    try {
      const head = Buffer.allocUnsafe(WINDOW)
      // Only the bytes actually read may be decoded. The buffer is uninitialised, so a file
      // shorter than the window would otherwise have whatever was in that memory parsed as
      // transcript lines.
      const { bytesRead } = await handle.read(head, 0, WINDOW, 0)
      const headLines = head.subarray(0, bytesRead).toString('utf8').split('\n')
      headLines.pop() // Drop the trailing partial line.
      this.applyLines(state.acc, headLines)
      // An open question is the one thing the head knows that the middle could have
      // settled. Every other field the head contributes either only grows or is overwritten
      // by the tail, but a question stays open until something clears it, and the record
      // that would have is exactly what the skip throws away. Forgetting it here is what
      // keeps the sampled path to what it actually knows.
      state.acc.ask = null

      // A file smaller than the window was read whole by the head, so there is no tail to
      // take. Without this the length goes negative and the allocation throws, which fails
      // the entire fleet scan rather than one file — reachable by setting
      // `AIVIS_FULL_PARSE_MAX_MB` below the 0.5 the window is fixed at.
      const tailStart = Math.max(WINDOW, size - WINDOW)
      const tailLength = size - tailStart
      if (tailLength > 0) {
        const tail = Buffer.allocUnsafe(tailLength)
        const { bytesRead: tailBytes } = await handle.read(tail, 0, tailLength, tailStart)
        const tailLines = tail.subarray(0, tailBytes).toString('utf8').split('\n')
        tailLines.shift() // Drop the leading partial line.
        this.applyLines(state.acc, tailLines)
      }
    } finally {
      await handle.close()
    }
    state.offset = size
    state.partial = NO_BYTES
    state.sampled = true
  }

  private applyLines(acc: Accumulator, lines: string[]): void {
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        applyRecord(acc, JSON.parse(line) as TranscriptRecord)
      } catch {
        // A partially flushed or straddled line is skipped.
      }
    }
  }

  /** True when the file was read by sampling rather than in full. */
  isSampled(filePath: string): boolean {
    return this.files.get(filePath)?.sampled ?? false
  }

  /** Size of the transcript in bytes as of the last read. */
  sizeOf(filePath: string): number {
    return this.files.get(filePath)?.size ?? 0
  }

  forget(filePath: string): void {
    this.files.delete(filePath)
    this.skipped.delete(filePath)
  }

  get(filePath: string): Accumulator | undefined {
    return this.files.get(filePath)?.acc
  }
}

/**
 * Build the display record for one session. `livePids` and `isForeground` come from
 * process inspection rather than the transcript, so they are supplied by the caller.
 */
export function toSession(
  filePath: string,
  acc: Accumulator,
  opts: {
    livePids: number[]
    isForeground: boolean
    git: Session['git']
    contextLimit: Session['contextLimit']
    staleAfterMs: number
    /**
     * How old an unanswered question may be before it stops being reported.
     *
     * A question is recorded when it is asked and cleared when it is answered, and a
     * session killed mid-dialogue writes neither an answer nor anything else — so the
     * question stays in the file for good. That is harmless until a process is attributed
     * to the transcript again, which aivis does by directory and recency rather than by
     * identity, at which point a question nobody can answer any more would sit at the top
     * of the queue for ever. The same window that decides a stopped session is a terminal
     * you left open decides this.
     */
    askWindowMs: number
    /** How long a task with no completion notice is still believed to be running. */
    taskWindowMs: number
    /**
     * True when aivis is holding a decision open for this session on its own standard
     * input, which is the case a silent transcript would otherwise be read as a stall.
     */
    heldByDriver?: boolean
    sampled: boolean
    transcriptBytes: number
    /** True when aivis saw this session alive before, so it is kept ready to continue. */
    parked?: boolean
  },
): Session {
  // `ingest` refuses a transcript whose id is not plausibly one, so the fallback below is
  // only reachable by a caller that assembled the accumulator some other way. It is here so
  // that an unvetted string can never leave this function as an id, not because it happens.
  const id = sessionIdOf(filePath, acc) ?? 'unnamed-session'
  const cwd = acc.cwd ?? path.dirname(filePath)
  const lastActivityAt = acc.lastActivityAt ?? new Date(0).toISOString()
  const ageMs = Date.now() - new Date(lastActivityAt).getTime()
  const alive = opts.livePids.length > 0

  // A question only counts while a process is there to receive the answer, and while it is
  // recent enough to still be a live dialogue. One left in a transcript whose session has
  // ended is history, and one from days ago is an abandoned terminal rather than something
  // waiting on you — see `askWindowMs`.
  const askAgeMs = acc.ask ? Date.now() - new Date(acc.ask.at).getTime() : Infinity
  const ask = alive && askAgeMs < opts.askWindowMs ? acc.ask : null

  // Nothing is running without a process to run it, and the notice that ends a task is not
  // guaranteed to have been written — a session killed mid-task never writes one. Both
  // bounds are needed: without the first, every transcript that ever launched anything
  // would report it for ever; without the second, a live session that lost a notice would.
  const background = alive
    ? [...acc.tasks.values()].filter(
        (task) => Date.now() - new Date(task.at).getTime() < opts.taskWindowMs,
      )
    : []

  let status: Session['status']
  // A session with no process is parked rather than ended when aivis has seen it running:
  // the machine went down, the conversation did not.
  if (!alive) status = opts.parked ? 'parked' : 'ended'
  else if (acc.lastShape === 'assistant-end') status = 'idle'
  // A session stopped for a decision is stopped for a reason aivis can name, so it keeps
  // reporting as working rather than ageing into `stalled`, whose whole meaning is that
  // nobody knows why it went quiet. The queue it belongs in is `asking`. A permission
  // prompt writes no record at all while it waits, which is why the driver has to say so:
  // the transcript looks identical to a session that simply stopped.
  else if (ask || opts.heldByDriver) status = 'working'
  else if (ageMs > opts.staleAfterMs) status = 'stalled'
  else status = 'working'

  return {
    id,
    cwd,
    projectName: path.basename(cwd) || cwd,
    transcriptPath: filePath,
    title: acc.title ?? acc.summary ?? '(no prompt yet)',
    status,
    startedAt: acc.startedAt ?? lastActivityAt,
    lastActivityAt,
    model: acc.model,
    effort: acc.effort,
    contextLimit: opts.contextLimit,
    permissionMode: acc.permissionMode,
    version: acc.version,
    userTurns: acc.userTurns,
    assistantTurns: acc.assistantTurns,
    toolCalls: acc.toolCalls,
    subagentTurns: acc.subagentTurns,
    tokens: acc.tokens,
    git: opts.git,
    lastActivity: acc.lastActivity,
    ask,
    background,
    livePids: opts.livePids,
    isForeground: opts.isForeground,
    sampled: opts.sampled,
    transcriptBytes: opts.transcriptBytes,
    pulse: pulseOf(acc),
  }
}
