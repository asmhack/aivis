import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { recordReportedLimits } from './blocks.ts'
import { config } from './config.ts'
import type {
  AskDecision,
  AskQuestion,
  DriverState,
  DriverStatus,
  OutgoingImage,
  PendingAsk,
  PermissionSuggestion,
} from '../shared/types.ts'

/**
 * Environment variables that must not reach a session aivis launches.
 *
 * `ANTHROPIC_API_KEY` would switch the child from the CLI's claude.ai login to API
 * billing. The `CLAUDE_*` variables are set when aivis itself runs inside a Claude Code
 * session, and passing them on would make the child believe it is that session's own
 * subprocess.
 */
const STRIPPED = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
]

/**
 * The environment for anything aivis starts beside a session — the `claude` child itself,
 * and the shell a `!` line runs in. Both want the same list gone for the same reason: a
 * command that starts its own `claude` must not inherit this session's identity or be
 * flipped from the CLI's login onto API billing.
 */
export function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of STRIPPED) delete env[key]
  return env
}

/**
 * Runs one Claude Code session as a child process that aivis can send messages to.
 *
 * The session is resumed by id, so it keeps its history and keeps writing to the same
 * transcript file. That means the dashboard's existing transcript watcher renders
 * whatever the driver produces, and the driver only has to report its own state.
 *
 * Standard input stays open between messages, which is what keeps the process alive for
 * a conversation rather than a single exchange.
 */
/**
 * The effort levels Claude Code accepts, in the order it lists them.
 *
 * `ultracode` is the CLI's own alias rather than a sixth level of its own: it runs the
 * turn at `xhigh` and additionally lets the session orchestrate dynamic workflows, and
 * `--effort ultracode` is taken verbatim even though `claude --help` only spells out the
 * five plain levels.
 */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']

/** The tool Claude Code calls to put a multiple-choice question to you. */
const ASK_TOOL = 'AskUserQuestion'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/**
 * How much of one string in a tool's input travels to the browser.
 *
 * A permission prompt carries the input verbatim so the page can show what it would
 * actually do, and a Write of a large file would otherwise put the whole file on every
 * connected socket on every driver update. What is shown is enough to recognise the call;
 * the transcript holds the rest once it runs.
 */
const MAX_INPUT_CHARS = 2000

/** Shorten the long strings in a tool's input, leaving its shape alone. */
function trimInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    out[key] =
      typeof value === 'string' && value.length > MAX_INPUT_CHARS
        ? value.slice(0, MAX_INPUT_CHARS) + '\n… truncated'
        : value
  }
  return out
}

/**
 * The longest single line of stream-json output the driver will hold on to.
 *
 * Events are newline-delimited, so a line has to be buffered whole before anything can be
 * done with it — and parsing copies it a second time — which means one line that never
 * ends is one allocation that never stops growing. The largest legitimate line is a
 * message carrying images: aivis accepts a request body of up to 40 MB (`MAX_BODY_BYTES`
 * in index.ts) and passes the base64 through verbatim, so 64 MB leaves room for that whole
 * message to come back on the output stream with an envelope around it. A line past that
 * is a runaway stream rather than a turn, and buffering it on only trades the child's
 * problem for the daemon's.
 */
const MAX_LINE_CHARS = 64 * 1024 * 1024

/**
 * How long a child gets to act on the SIGTERM an overflow sends before it is killed outright.
 *
 * A driver stays registered until its child exits, because the registry is the only place
 * `endSession` can learn the pid of a `claude` aivis may stop — so a child that ignores its
 * SIGTERM would keep the session pinned rather than escape it, and nothing would ever come
 * along to unpin it. This is long enough for an ordinary shutdown to happen first and short
 * enough that a wedged child is not still writing when the next send arrives. A process last
 * seen emitting an endless line is not the one most likely to notice a polite signal.
 */
const OVERFLOW_KILL_MS = 5000

/**
 * Read the questions out of an `AskUserQuestion` call, or null if this is not one.
 *
 * Claude Code has already validated this against the tool's schema by the time it asks,
 * so the checks here are about aivis not drawing a card it cannot draw — a question with
 * no options has no answer to give — rather than about second-guessing the model.
 */
function readQuestions(toolName: string, input: Record<string, unknown>): AskQuestion[] | null {
  if (toolName !== ASK_TOOL) return null
  const raw = input.questions
  if (!Array.isArray(raw)) return null
  const questions: AskQuestion[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const question = str(entry.question)
    if (!question) continue
    const options = Array.isArray(entry.options)
      ? entry.options.flatMap((option) => {
          if (!isRecord(option)) return []
          const label = str(option.label)
          if (!label) return []
          return [{
            label,
            ...(str(option.description) ? { description: option.description as string } : {}),
            ...(str(option.preview) ? { preview: option.preview as string } : {}),
          }]
        })
      : []
    if (options.length === 0) continue
    questions.push({
      question,
      header: str(entry.header) ?? question,
      options,
      multiSelect: entry.multiSelect === true,
    })
  }
  return questions.length > 0 ? questions : null
}

/**
 * Join several picked labels the way Claude Code's own dialogue joins them.
 *
 * Claude Code parses the joined string back and checks that every part names a real
 * option; a plain `join(', ')` fails that check the moment a label contains a comma and a
 * space or a double quote, because the split cuts the label in half or the parser refuses
 * the segment outright. Seventeen percent of the option labels written on this machine
 * contain one or the other — "Keep it, make the copy honest (Recommended)" is typical — so
 * this is a normal label, not a pathological one.
 *
 * Quoting the awkward ones is what Claude Code itself does, and it is the difference
 * between the model being told its questions were answered and being told to read a
 * freehand reply carefully. Sending an array instead does not help: the input schema
 * flattens it with the same unquoted join before the check ever runs.
 */
function joinLabels(labels: string[]): string {
  return labels
    .map((label) => (label.includes(', ') || label.includes('"') ? JSON.stringify(label) : label))
    .join(', ')
}

/**
 * Build the input the answered tool call runs with.
 *
 * Answering a question is not an approval with a note attached: the answers *are* the
 * tool's input. `AskUserQuestion` reads them straight back out of the input it is given,
 * keyed by each question's own text, so an allow that carries them is indistinguishable
 * from the terminal's own dialogue as far as the model is concerned.
 */
function answeredInput(
  pending: { ask: PendingAsk; input: Record<string, unknown> },
  answers: Record<string, string | string[]> | undefined,
): Record<string, unknown> {
  if (!pending.ask.questions || !answers) return pending.input
  const collected: Record<string, string> = {}
  for (const [question, value] of Object.entries(answers)) {
    const answer = Array.isArray(value) ? joinLabels(value) : value
    if (answer.trim()) collected[question] = answer
  }
  // A question nobody answered is left out rather than sent empty, which is what the
  // terminal does when somebody tabs past one. Claude Code drops an unanswered question
  // from the result entirely rather than reporting it as skipped, so the model sees the
  // answers that were given and no mention of the ones that were not — worth knowing
  // before deciding that a partial answer needs its own wording here.
  return { ...pending.input, answers: collected }
}

/** How a driver should be started. */
export interface DriverOptions {
  /** Resume this session, or omit to start a new one. */
  sessionId?: string
  cwd: string
  model?: string
  permissionMode?: string
  /** `low` through `max`. Left unset, the session takes Claude Code's own default. */
  effort?: string
}

export class SessionDriver {
  /** Null only for a new session, until Claude Code reports the id it minted. */
  sessionId: string | null
  readonly cwd: string
  /** Resolves with the session id once the process reports it. */
  readonly ready: Promise<string>
  private announce!: (id: string) => void
  private proc: ChildProcessWithoutNullStreams
  /**
   * The line being read, in the pieces it arrived in, none of them holding a newline.
   *
   * Kept apart rather than concatenated because joining on every chunk is what makes reading
   * a long line quadratic — see `consume()`. They are joined exactly once, when the newline
   * that ends the line finally turns up.
   */
  private readonly parts: string[] = []
  /** How much `parts` holds, so the cap can be checked without measuring the pieces again. */
  private held = 0
  /** Set once a line outgrew `MAX_LINE_CHARS`, after which nothing more is read. */
  private overflowed = false
  /** Why an overflow ended the session, which outranks whatever the exit that follows says. */
  private overflowDetail: string | null = null
  /** The SIGKILL standing behind an overflow's SIGTERM, dropped as soon as the child exits. */
  private killTimer: ReturnType<typeof setTimeout> | null = null
  private stateValue: DriverState = 'starting'
  private detail: string | null = null
  private pending = 0
  private readonly permissionMode: string
  /** Control requests are correlated by id, so each interrupt needs its own. */
  private controlSeq = 0
  /** Interrupts asked for and not yet answered, so their turn is not read as a failure. */
  private readonly interrupts = new Set<string>()
  /** True from an accepted interrupt until the turn it cut short reports itself. */
  private stopping = false
  /**
   * Decisions the session is holding for, keyed by the request that asked.
   *
   * The raw input is kept beside the browser-facing record because answering means
   * handing the input back — extended with the answers for a question, untouched for a
   * permission prompt — and the trimmed copy the page draws would corrupt a large file.
   */
  private readonly asks = new Map<string, { ask: PendingAsk; input: Record<string, unknown> }>()

  constructor(
    options: DriverOptions,
    private readonly onChange: (status: DriverStatus) => void,
  ) {
    this.sessionId = options.sessionId ?? null
    this.cwd = options.cwd
    this.permissionMode = options.permissionMode ?? config.permissionMode
    this.ready = new Promise<string>((resolve) => {
      this.announce = resolve
      if (options.sessionId) resolve(options.sessionId)
    })

    const args = [
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      this.permissionMode,
    ]
    // Route every decision the session cannot make on its own to aivis instead of letting
    // it die unanswered.
    //
    // `stdio` is not a tool name. It is the sentinel that tells Claude Code to put its
    // permission prompts on the same standard-output stream as everything else, as
    // `can_use_tool` control requests, and to wait for an answer on standard input — the
    // channel the Claude Agent SDK uses for its own `canUseTool` callback. Without it a
    // decision has no surface to appear on: Claude Code says so in as many words, denies
    // the call as "no prompt available in headless mode", and the turn carries on having
    // silently lost whatever it stopped to ask.
    //
    // This is what makes a question answerable from a browser, and it is all or nothing:
    // ordinary permission prompts arrive the same way and must be answered too, or the
    // session waits forever. `AIVIS_ANSWER_ASKS=0` gives the old behaviour back.
    if (config.answerAsks) args.push('--permission-prompt-tool', 'stdio')
    // Without --resume, Claude Code starts a fresh session and mints the id itself.
    if (options.sessionId) args.push('--resume', options.sessionId)
    if (options.model) args.push('--model', options.model)
    // An unrecognised level is only warned about and ignored by the CLI, so the set is
    // checked here rather than starting a session that quietly runs at the default.
    if (options.effort && EFFORTS.includes(options.effort)) args.push('--effort', options.effort)

    this.proc = spawn(config.claudeBin, args, {
      cwd: options.cwd,
      env: childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // A pipe whose reader has gone raises EPIPE on the *stream*, and a stream with no
    // error listener turns that into an uncaught exception that would take the whole aivis
    // daemon down and orphan every other driven session. There is nothing to do about it
    // beyond not dying: the exit handler below is what actually reports the session gone.
    this.proc.stdin.on('error', (err) => {
      console.error(`[aivis] driver ${(this.sessionId ?? 'new').slice(0, 8)} stdin: ${err.message}`)
    })
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk: string) => this.consume(chunk))
    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (chunk: string) => {
      const text = chunk.trim()
      if (text) console.error(`[aivis] driver ${(this.sessionId ?? 'new').slice(0, 8)}: ${text.slice(0, 300)}`)
    })
    this.proc.on('error', (err) => this.finish('error', err.message))
    this.proc.on('exit', (code, signal) =>
      this.finish(code === 0 ? 'exited' : 'error', signal ? `signal ${signal}` : `exit code ${code}`),
    )
  }

  get status(): DriverStatus {
    return {
      sessionId: this.sessionId ?? '',
      state: this.stateValue,
      detail: this.detail,
      queued: this.pending,
      permissionMode: this.permissionMode,
      asks: [...this.asks.values()].map((pending) => pending.ask),
    }
  }

  get alive(): boolean {
    return this.stateValue !== 'exited' && this.stateValue !== 'error'
  }

  /**
   * The process id of the `claude` this driver spawned.
   *
   * Null only in the moment before the child is up. This is the one `claude` pid aivis knows
   * rather than guesses, which is what lets `endSession` stop it despite the `--print` it was
   * launched with — every other pid there comes from a machine-wide scan. It deliberately does
   * not depend on `alive`, because the pid is read immediately before `stop()` and the exit
   * that flips `alive` arrives asynchronously afterwards.
   */
  get pid(): number | null {
    return this.proc.pid ?? null
  }

  /**
   * Queue one user message, optionally with images.
   *
   * Images go inline as base64 blocks, which is what the streaming input format accepts,
   * so nothing has to be written to disk for Claude to see a pasted screenshot. Images
   * come first: a screenshot is usually the subject the text refers to.
   */
  send(text: string, images: OutgoingImage[] = []): boolean {
    if (!this.alive) return false
    const content: unknown[] = images.map((image) => ({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.data },
    }))
    if (text) content.push({ type: 'text', text })
    if (!this.write({ type: 'user', message: { role: 'user', content } })) return false
    this.pending += 1
    this.setState('working')
    return true
  }

  /**
   * Stop the turn in progress without ending the session.
   *
   * Standard input carries control requests as well as user messages, and `interrupt` is
   * the one that cuts a turn short — the same thing pressing escape does in the terminal.
   * The session answers with a control response naming whatever is still queued, then ends
   * the turn and stays alive for the next message, so this is a stop rather than a kill.
   *
   * The turn it cuts short reports itself as an error, which is true of the turn but not
   * of the session, so the ask is remembered and the result is reported as a stop instead.
   */
  interrupt(): boolean {
    if (!this.alive || this.stateValue !== 'working') return false
    const requestId = `aivis-interrupt-${++this.controlSeq}`
    this.interrupts.add(requestId)
    if (!this.write({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } })) {
      this.interrupts.delete(requestId)
      return false
    }
    return true
  }

  /**
   * Answer one decision the session is holding for.
   *
   * The answer is a control response on standard input, addressed to the request that
   * asked. Claude Code is holding the tool call open waiting for exactly this, so the turn
   * resumes the moment it lands — nothing is queued and nothing is resumed.
   *
   * Answering carries the weight of your own turn, unlike a message sent over a session's
   * socket, because aivis owns this process and writes to its standard input. That is the
   * whole reason only a driven session can be answered from here.
   */
  answer(requestId: string, decision: AskDecision): boolean {
    const pending = this.asks.get(requestId)
    if (!pending || !this.alive) return false

    const response =
      decision.behavior === 'allow'
        ? {
            behavior: 'allow',
            updatedInput: answeredInput(pending, decision.answers),
            // Accepting the suggestion is what stops the same prompt arriving again for
            // the rest of the session. The shapes are Claude Code's own, so they go back
            // exactly as they came.
            ...(decision.suggestions && pending.ask.suggestions.length > 0
              ? { updatedPermissions: pending.ask.suggestions }
              : {}),
            toolUseID: pending.ask.toolUseId,
          }
        : {
            behavior: 'deny',
            // The message is what the model reads as the tool's error, so a denial with a
            // reason is worth far more to it than a bare refusal.
            message: decision.message?.trim() || 'Declined from aivis.',
            toolUseID: pending.ask.toolUseId,
          }

    // The ask is forgotten only once the frame is away. Dropping it first would answer a
    // card off the screen and report success for a decision the session never received.
    if (!this.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    })) {
      return false
    }
    this.asks.delete(requestId)
    this.onChange(this.status)
    return true
  }

  /** Stop the session. The transcript is already on disk, so it can be resumed later. */
  stop(): void {
    if (!this.alive) return
    this.proc.stdin.end()
    this.proc.kill('SIGTERM')
  }

  /**
   * Take in a decision Claude Code is asking aivis to make.
   *
   * Nothing is answered here. The request is held as state and published, and the turn
   * stays stopped until somebody answers it from the page — which is what a permission
   * prompt does in a terminal too.
   */
  private receiveRequest(event: {
    request_id?: string
    request?: Record<string, unknown>
  }): void {
    const request = event.request
    const requestId = event.request_id
    if (!requestId || !request) return

    if (request.subtype !== 'can_use_tool') {
      // Anything else on this channel is something aivis never offered to do. Saying so is
      // better than silence, which would leave the session waiting on an answer that is
      // never coming.
      this.write({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error: `aivis does not handle control requests of type ${String(request.subtype)}`,
        },
      })
      return
    }

    const input = isRecord(request.input) ? request.input : {}
    const toolName = str(request.tool_name) ?? 'unknown tool'
    const questions = readQuestions(toolName, input)
    // Only the suggestions that end with the session are kept.
    //
    // Claude Code offers these with a `destination` of their own, and several of them —
    // most of the `addRules` ones — are written to the project's `.claude/settings.local.json`
    // and outlive the session entirely, granting the same permission to every later run in
    // that directory including terminals aivis has nothing to do with. A button in a
    // dashboard saying "stop asking" is understood to mean stop asking me now, not to
    // change a file on disk, so the ones that do that are dropped rather than relabelled:
    // a standing rule is worth writing deliberately, where such rules are kept.
    const suggestions = Array.isArray(request.permission_suggestions)
      ? (request.permission_suggestions
          .filter(isRecord)
          .filter((suggestion) => suggestion.destination === 'session') as PermissionSuggestion[])
      : []

    const ask: PendingAsk = {
      requestId,
      toolUseId: str(request.tool_use_id) ?? '',
      toolName,
      displayName: str(request.display_name) ?? toolName,
      questions,
      // A question's input is its questions, which are already here. Carrying it twice
      // would put every option's preview on the wire a second time.
      input: questions ? null : trimInput(input),
      description: str(request.description),
      reason: str(request.decision_reason),
      suggestions,
      at: new Date().toISOString(),
    }
    this.asks.set(requestId, { ask, input })
    this.onChange(this.status)
  }

  /** Drop a request Claude Code has stopped waiting on, so a dead card leaves the page. */
  private cancelRequest(requestId: string | undefined): void {
    if (!requestId || !this.asks.delete(requestId)) return
    this.onChange(this.status)
  }

  /**
   * Put one frame on the session's standard input, and say whether it went.
   *
   * `alive` follows the exit event, which Node delivers a tick or more after the process
   * has actually gone, so there is always a window where a dead session still looks live.
   * `writable` closes that window — and closes the quieter one after `stop()`, where
   * standard input has been ended but the exit event has not arrived, and a write would be
   * discarded in silence while the caller reported success.
   */
  private write(frame: unknown): boolean {
    if (!this.alive || !this.proc.stdin.writable) return false
    // The return value is backpressure, not delivery, so it is deliberately not read: a
    // full buffer still means the frame is queued and will be flushed.
    this.proc.stdin.write(JSON.stringify(frame) + '\n')
    return true
  }

  /**
   * Take one chunk of the child's standard output and act on every event it completes.
   *
   * Only the arriving chunk is searched for newlines. The obvious shape — append to one
   * string and split the whole accumulation on every chunk — is quadratic in the length of a
   * line, because V8 has to flatten that accumulation before it can be searched: a line
   * arriving over a pipe in 64 KB chunks is copied end to end once per chunk, so one that
   * merely approaches the cap costs seconds of event loop and gigabytes of copying before
   * the cap ever fires. Every other driven session, every websocket broadcast and every
   * fleet refresh is served from that same loop, so that cost is never this session's alone.
   * The unfinished line is therefore held as the pieces it arrived in and joined once.
   */
  private consume(chunk: string): void {
    // Nothing is read after an overflow. Everything that follows one is the tail of the
    // line that overflowed, and the tail of a record is not a record: a child that pads an
    // event out past the cap would otherwise have the remainder parsed as an event in its
    // own right, which is a forged event rather than a recovered one. The session is on its
    // way out by then anyway, so there is no state left for a resynchronised stream to
    // update.
    if (this.overflowed) return

    // Every line this chunk completed, taken before any of them is acted on: an event that
    // shared its chunk with the start of a runaway line is still a whole event, and is worth
    // handling before the runaway one ends the session below.
    const lines: string[] = []
    let start = 0
    for (let nl = chunk.indexOf('\n'); nl !== -1; nl = chunk.indexOf('\n', start)) {
      // Whatever was held from earlier chunks is the front of this line and of no other, so
      // it is joined on here and released in the same breath.
      this.parts.push(chunk.slice(start, nl))
      lines.push(this.parts.join(''))
      this.parts.length = 0
      this.held = 0
      start = nl + 1
    }
    // Slicing a chunk that had no newline in it at all would copy it for nothing.
    const rest = start === 0 ? chunk : chunk.slice(start)
    if (rest) {
      this.parts.push(rest)
      this.held += rest.length
    }

    for (const line of lines) {
      if (!line.trim()) continue
      let event: {
        type?: string
        subtype?: string
        is_error?: boolean
        session_id?: string
        rate_limit_info?: unknown
        // A control request travels the other way to everything else here: Claude Code is
        // asking aivis something rather than reporting on itself.
        request_id?: string
        request?: Record<string, unknown>
        // A control response nests its own subtype and request id one level down, beside
        // the payload — the envelope carries only the type.
        response?: {
          subtype?: string
          request_id?: string
          response?: { still_queued?: unknown[] }
        }
      }
      try {
        event = JSON.parse(line) as typeof event
      } catch {
        continue
      }
      // Claude Code puts its questions and its permission prompts on this channel, which
      // is what --permission-prompt-tool opted into. Neither is answered here: both are
      // held as state and published, and the turn stays stopped until somebody answers.
      if (event.type === 'control_request') {
        this.receiveRequest(event)
        continue
      }
      // Claude Code has stopped waiting on an answer, usually because the turn was cut
      // short, so the card that offered it goes away rather than answering into nothing.
      if (event.type === 'control_cancel_request') {
        this.cancelRequest(event.request_id)
        continue
      }
      // Rate limits are account-wide, so any driven session reports for the whole fleet.
      // This is the freshest source there is: the status line's file only moves when a
      // terminal session redraws, which an idle machine may not do for hours.
      if (event.type === 'rate_limit_event') {
        recordReportedLimits(event.rate_limit_info)
        continue
      }
      if (event.type === 'control_response') {
        const answer = event.response
        if (!answer?.request_id || !this.interrupts.delete(answer.request_id)) continue
        if (answer.subtype !== 'success') continue
        // The session reports what survived the interrupt, which is a better count than
        // the one kept here: anything queued behind the cancelled turn still runs.
        const queued = answer.response?.still_queued
        this.pending = Array.isArray(queued) ? queued.length : 0
        this.stopping = true
        continue
      }
      if (event.type === 'system' && event.subtype === 'init') {
        if (!this.sessionId && event.session_id) {
          this.sessionId = event.session_id
          this.announce(event.session_id)
        }
        this.setState(this.pending > 0 ? 'working' : 'idle')
      }
      if (event.type === 'result') {
        // A pending ask belongs to a turn in flight, so a turn that has reported its
        // result is not waiting on one any more however it ended. Clearing here rather
        // than on the interrupt itself is what keeps a cancelled turn from leaving a card
        // that answers into nothing, without ever hiding a request still being waited on.
        if (this.asks.size > 0) this.asks.clear()
        if (this.stopping) {
          // The interrupt already reset the count from what the session reported, and the
          // error this turn carries is the interrupt itself rather than a failure.
          this.stopping = false
          this.detail = 'stopped'
        } else {
          this.pending = Math.max(0, this.pending - 1)
          this.detail = event.is_error === true ? 'last turn ended with an error' : null
        }
        this.setState(this.pending > 0 ? 'working' : 'idle')
      }
    }

    // What is held is everything written since the last newline, so more of it than the cap
    // is an event that is either enormous or never going to end. Holding on to it is how one
    // child takes the whole daemon down and orphans every other driven session with it.
    if (this.held > MAX_LINE_CHARS) this.overrun()
  }

  /**
   * Drop a line that outgrew the cap, and take the session that was writing it down too.
   *
   * The line is discarded rather than followed half-blind, because a line nobody could read
   * may have been the permission request the turn is now waiting on for good, and nothing
   * after it can be trusted to be an event either.
   *
   * The driver is deliberately not finished here, even though the reason it is ending is
   * already known. `finish()` is what unregisters a driver, and a driver that leaves the
   * registry while its child is still alive takes with it the one `claude` pid aivis can
   * claim as its own: `endSession` reads that pid from the registry, and `terminate` refuses
   * to signal a `--print` process it cannot claim, so a child that outlived its SIGTERM would
   * become unkillable from the page and `stopAll()` would miss it at shutdown too. The
   * session id would also be free to be resumed again immediately, putting a second `claude`
   * on the same transcript as the one still dying. So the reason is recorded and published,
   * the child is stopped, and the exit that follows is what finishes the driver — reporting
   * this reason rather than the signal that brought it about.
   */
  private overrun(): void {
    this.parts.length = 0
    this.held = 0
    this.overflowed = true
    this.overflowDetail = `stopped: one output line exceeded ${MAX_LINE_CHARS / (1024 * 1024)} MB`
    console.error(`[aivis] driver ${(this.sessionId ?? 'new').slice(0, 8)}: ${this.overflowDetail}`)
    // Said now rather than on the exit, because the exit may be a few seconds away and the
    // page would otherwise show a working session that has stopped reading its own output.
    this.detail = this.overflowDetail
    this.onChange(this.status)
    this.stop()
    // And the guarantee that the exit does arrive, so nothing waits on this child forever.
    this.killTimer = setTimeout(() => {
      try {
        this.proc.kill('SIGKILL')
      } catch {
        // Already gone, which is the outcome this was here for.
      }
    }, OVERFLOW_KILL_MS)
    // Unref'd: a child on its way out must not hold the daemon open behind it.
    this.killTimer.unref()
  }

  private setState(next: DriverState): void {
    if (this.stateValue === next) {
      this.onChange(this.status)
      return
    }
    this.stateValue = next
    this.onChange(this.status)
  }

  private finish(state: DriverState, detail: string): void {
    if (!this.alive) return
    // The process this was chasing has reported itself, so there is nothing to escalate to.
    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }
    // An overflow is why the session ended, however the exit that carried it out describes
    // itself: it outranks `signal SIGTERM`, and it outranks the clean `exit code 0` a child
    // that shut down politely would otherwise be reported as having ended with.
    this.stateValue = this.overflowDetail ? 'error' : state
    this.detail = this.overflowDetail ?? detail
    this.pending = 0
    // Whatever the process was asking died with it.
    this.asks.clear()
    this.onChange(this.status)
  }
}

/** Fail rather than hang when a session never reports its id. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('the session did not start in time')), ms),
    ),
  ])
}

/** Keeps one driver per session and hands out their status. */
export class DriverRegistry {
  private drivers = new Map<string, SessionDriver>()

  constructor(private readonly onChange: (status: DriverStatus) => void) {}

  get(sessionId: string): SessionDriver | undefined {
    const driver = this.drivers.get(sessionId)
    if (driver && !driver.alive) {
      this.drivers.delete(sessionId)
      return undefined
    }
    return driver
  }

  start(sessionId: string, cwd: string): SessionDriver {
    const existing = this.get(sessionId)
    if (existing) return existing
    const driver = this.spawn({ sessionId, cwd })
    this.drivers.set(sessionId, driver)
    return driver
  }

  /**
   * Start a session that does not exist yet.
   *
   * A fresh process announces nothing until it has something to work on, so the opening
   * message is written before the id is awaited. The id is minted by Claude Code and
   * arrives with the first event, so the driver is registered once it is known.
   */
  async startNew(
    options: Omit<DriverOptions, 'sessionId'>,
    first: { text: string; images?: OutgoingImage[] },
  ): Promise<SessionDriver> {
    const driver = this.spawn(options)
    driver.send(first.text, first.images ?? [])
    try {
      const sessionId = await withTimeout(driver.ready, 90000)
      this.drivers.set(sessionId, driver)
      return driver
    } catch (err) {
      driver.stop()
      throw err
    }
  }

  private spawn(options: DriverOptions): SessionDriver {
    return new SessionDriver(options, (status) => {
      if (status.state === 'exited' || status.state === 'error') {
        if (status.sessionId) this.drivers.delete(status.sessionId)
      }
      this.onChange(status)
    })
  }

  statuses(): DriverStatus[] {
    return [...this.drivers.values()].map((d) => d.status)
  }

  stopAll(): void {
    for (const driver of this.drivers.values()) driver.stop()
    this.drivers.clear()
  }
}
