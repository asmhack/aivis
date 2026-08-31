/** Types shared by the aivis server and web client. */

/**
 * Lifecycle state of a session, derived from its transcript and from whether a
 * `claude` process is alive in its working directory.
 *
 * `working` and `idle` describe a session that is still alive. `stalled` means the
 * process is alive but the transcript has not advanced for a while, which usually
 * means Claude is waiting on a permission prompt or on a long-running command.
 * `parked` means no process is running, but aivis saw this session alive before — across
 * a reboot, say — so it is kept ready to continue rather than filed away.
 * `ended` means no live process backs the session any more.
 */
export type SessionStatus = 'working' | 'idle' | 'stalled' | 'parked' | 'ended'

/** A single tool invocation, summarized for display. */
export interface ActivitySummary {
  /** Tool name, such as `Bash` or `Edit`. */
  tool: string
  /** One-line description of what the tool was asked to do. */
  detail: string
  /** ISO timestamp of the invocation. */
  at: string
}

/**
 * One tool call an agent made, with what it was asked and what came back.
 *
 * An agent's calls live in its own transcript rather than the parent's, so they are read
 * from that file on demand — asking for every agent's calls up front would be megabytes
 * for a session that launched sixty of them.
 */
export interface AgentToolCall extends ActivitySummary {
  id: string
  input: Record<string, unknown>
  /** Result text, or null when the agent stopped before the tool answered. */
  result: string | null
  isError: boolean
  resultTruncated: boolean
}

/** Token accounting accumulated across a session's assistant turns. */
export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  /** Size of the context window on the most recent turn. */
  contextWindow: number
}

/** Uncommitted change size in a session's working directory. */
export interface GitState {
  branch: string | null
  filesChanged: number
  insertions: number
  deletions: number
  /** True when the directory is a git repository. */
  isRepo: boolean
}

/**
 * How aivis knows how large a session's context window is.
 *
 * Strongest first. `reported` is Claude Code's own figure, published by the status line.
 * `exceeded` is proof rather than inference: a session already past the standard window
 * must have the long one. `model` is the `[1m]` suffix in the model id, which a transcript
 * usually drops. `settings` means the configured default asks for the long window and this
 * session runs that model family. `assumed` is the standard window, believed because
 * nothing said otherwise.
 */
export type ContextLimitSource = 'reported' | 'exceeded' | 'model' | 'settings' | 'assumed'

/** The context window to measure a session's usage against. */
export interface ContextLimit {
  tokens: number
  source: ContextLimitSource
}

/** Everything the fleet dashboard shows about one session. */
export interface Session {
  id: string
  /** Absolute working directory the session runs in. */
  cwd: string
  /** Last path segment of `cwd`, for compact display. */
  projectName: string
  /** Transcript file backing this session. */
  transcriptPath: string
  title: string
  status: SessionStatus
  /** ISO timestamp of the first record. */
  startedAt: string
  /** ISO timestamp of the most recent record. */
  lastActivityAt: string
  /** Model id from the most recent assistant turn. */
  model: string | null
  /**
   * Effort the most recent main-thread turn ran at: `low` through `max`.
   *
   * Recorded per turn, so this follows a mid-session `/effort` rather than reporting
   * whatever the session started with. Null for a session too old to have recorded it.
   */
  effort: string | null
  /** Permission mode last recorded, such as `bypassPermissions`. */
  permissionMode: string | null
  /** Claude Code version that wrote the most recent record. */
  version: string | null
  userTurns: number
  assistantTurns: number
  toolCalls: number
  /** Turns belonging to subagents rather than the main thread. */
  subagentTurns: number
  tokens: TokenUsage
  /**
   * The window `tokens.contextWindow` is a fraction of.
   *
   * Carried per session rather than derived in the browser, because the strongest
   * evidence for it — the status line's own capture, and your configured default — lives
   * on the machine the server runs on.
   */
  contextLimit: ContextLimit
  git: GitState
  /** Most recent tool invocation, or null when the session has made none. */
  lastActivity: ActivitySummary | null
  /**
   * The question this session is holding on, or null when it is not holding on one.
   *
   * Read from the transcript rather than from the driver, so a session running in a
   * terminal reports its question too. Whether it can be answered from here is a separate
   * matter, and `answerable` is the field that says so.
   */
  ask: AskSummary | null
  /**
   * Work still running outside the session's own turn, oldest first.
   *
   * Empty unless a process is alive, since nothing can be running without one, and bounded
   * by `AIVIS_TASK_WINDOW_HOURS` — a task whose completion notice never arrived would
   * otherwise be reported as running for ever.
   */
  background: BackgroundTask[]
  /** PIDs of live `claude` processes in this session's working directory. */
  livePids: number[]
  /** True when the transcript is the most recently written one in its directory. */
  isForeground: boolean
  /**
   * True when the transcript was too large to parse in full, so only its head and
   * tail were read. Activity and status stay accurate; turn and token counts are
   * lower bounds.
   */
  sampled: boolean
  /** Size of the transcript file in bytes. */
  transcriptBytes: number
  /**
   * Tool calls per minute over the last quarter of an hour, oldest first.
   *
   * This is what the sparkline on a running tile draws: not a rate anyone quotes, just
   * the shape of the last few minutes, so a session that has gone quiet reads as quiet
   * before its status has caught up.
   */
  pulse: number[]
}

/** Messages the server pushes over the WebSocket. */
export type ServerMessage =
  | { kind: 'snapshot'; sessions: Session[]; scannedAt: string }
  | { kind: 'update'; sessions: Session[] }
  | { kind: 'removed'; ids: string[] }
  | { kind: 'driver'; status: DriverStatus }

/** A tool invocation together with whatever it returned. */
export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  /** Result text, or null while the tool is still running. */
  result: string | null
  isError: boolean
  /** True when the result was cut down to keep the response small. */
  resultTruncated: boolean
}

/** An image attached to a message, referenced rather than inlined. */
export interface EntryImage {
  /** Position of the image block within the record's content. */
  index: number
  mediaType: string
}

/** An image being sent with a message, carried as base64. */
export interface OutgoingImage {
  mediaType: string
  /** Base64 payload without the data-URL prefix. */
  data: string
  name?: string
}

/**
 * One `!` bash line aivis ran on this machine, in the session's directory.
 *
 * A run is created the moment it starts and mutated when it finishes, because a `!` line
 * that takes a while — `npm test`, a `gcloud auth login` waiting on a browser — has to be
 * visible while it runs rather than only once it is over. `running` is what the page keys
 * that off, and it is also what keeps an unfinished run out of the next message: a command
 * still printing has no output to hand the model yet.
 */
export interface BashRun {
  /** Identifies the run while it waits to be sent. Not a transcript uuid; nothing has been recorded yet. */
  id: string
  /** What was typed after the `!`. */
  command: string
  /** When the command started, ISO 8601. */
  at: string
  running: boolean
  stdout: string
  stderr: string
  /** `null` while running, and for a command killed by a signal rather than exiting. */
  exitCode: number | null
  /** True when either stream hit `maxBytes` and the rest was read and dropped. */
  truncated: boolean
  /** True when the command outlived `timeoutMs` and its process group was killed. */
  timedOut: boolean
  /** Why the command never ran at all — a missing shell, a directory that is gone. */
  failure: string | null
  /** How long the command was given, so the record can say what it was killed after. */
  timeoutMs: number
  /** The per-stream output cap, so the record can say where it was cut. */
  maxBytes: number
  durationMs: number
}

/**
 * A `!` run recovered from a transcript, which knows less than the one that produced it.
 *
 * The recorded format carries the command and the two streams and nothing else, so an exit
 * status read back from a transcript is genuinely unknown rather than zero.
 */
export interface ParsedBashRun {
  command: string
  stdout: string
  stderr: string
  /** False for a terminal's first record, whose output is written as the record after it. */
  complete: boolean
}

/** One rendered item in a session's conversation. */
export type TranscriptEntry =
  | { kind: 'user'; uuid: string; at: string; text: string; images: EntryImage[] }
  | {
      kind: 'assistant'
      uuid: string
      at: string
      text: string
      thinking: string
      model: string | null
      sidechain: boolean
    }
  | { kind: 'tool'; uuid: string; at: string; sidechain: boolean; call: ToolCall }
  /**
   * A slash command the session ran, with whatever it printed.
   *
   * Claude Code records these as a synthetic user turn wrapped in `<command-name>` tags and
   * the output as a `local_command` system record, neither of which is a message. They are
   * shown because they can be run from here: a command that left no trace in the
   * conversation would be indistinguishable from one that never arrived.
   */
  | { kind: 'command'; uuid: string; at: string; text: string; output: string }
  /**
   * A `!` bash line, run on this machine rather than by the model.
   *
   * These are shown for the same reason slash commands are: they can be run from here, and
   * a run that left no trace would be indistinguishable from one that never happened. A
   * `pending` entry has not reached the transcript yet — it is held by the daemon and goes
   * out in front of the next message — so it is drawn from the daemon's own state and
   * disappears into a real entry once it has been sent.
   */
  | {
      kind: 'bash'
      uuid: string
      at: string
      command: string
      stdout: string
      stderr: string
      /** `null` when read back from a transcript, which does not record it. */
      exitCode: number | null
      running: boolean
      pending: boolean
    }
  /**
   * A message pushed into the session from outside it, over its message socket.
   *
   * Claude Code records these as their own kind of record rather than as user turns,
   * because they do not carry the user's authority — the session is told they came from
   * another session. Everything aivis sends to a terminal-owned session arrives this way,
   * so leaving them out of the conversation is what made a message sent from the composer
   * disappear from the page that sent it.
   */
  | {
      kind: 'queued'
      uuid: string
      at: string
      text: string
      /**
       * Pictures sent with the message, referenced rather than inlined — the same shape a
       * user turn carries them in, because a message pushed into a session can be a
       * screenshot with no words at all.
       */
      images: EntryImage[]
      /** Who the session recorded as the sender. `aivis` for anything the composer sent. */
      from: string
      /** The id the sender generated, which is how the composer recognises its own message. */
      sourceUuid: string | null
    }

/** Response body of the transcript endpoint. */
export interface TranscriptPage {
  sessionId: string
  entries: TranscriptEntry[]
  /** True when older records exist before the window that was read. */
  truncated: boolean
  /** Bytes read from the end of the file, so the client can ask for more. */
  bytesRead: number
  fileSize: number
}

/** A subagent launched by a session with the Agent tool. */
export interface Subagent {
  agentId: string
  /** The parent's `Agent` call that launched it, so the rail can point at it in the conversation. */
  callId: string | null
  /** Task description from the parent's Agent tool call, when it can be linked. */
  description: string | null
  /** Agent type from the parent's call, such as `general-purpose` or `Explore`. */
  agentType: string | null
  /** Opening prompt the agent was given, truncated. */
  prompt: string
  startedAt: string
  lastActivityAt: string
  assistantTurns: number
  toolCalls: number
  outputTokens: number
  /** Cumulative tokens across the agent's turns, input and output together. */
  tokens: number
  /**
   * How much context the agent was holding at its last turn, cache included.
   *
   * The cumulative figure above counts a cached prefix once per turn that read it, so it
   * climbs far past anything the agent ever held at one moment. This is the other reading:
   * the size of the last turn alone. It is also the figure a workflow run records for its
   * own agents, so the two agree about a run whichever of them it was read from.
   */
  contextTokens: number
  model: string | null
  lastActivity: ActivitySummary | null
  /** The agent's most recent tool calls, newest last. */
  recentTools: ActivitySummary[]
  /** The agent's latest prose, which is its running commentary or its answer. */
  notes: string | null
  /** `failed` when the parent's Agent call came back an error. */
  status: 'running' | 'done' | 'failed'
}

/** One agent step inside a workflow run, as the run recorded it. */
export interface WorkflowAgent {
  /** Position in the run, counting every agent across all phases. */
  index: number
  label: string
  phaseIndex: number
  phaseTitle: string
  agentId: string | null
  model: string | null
  /** Reported lifecycle state, such as `done`, `running`, or `failed`. */
  state: string
  /** Which try this was, when the workflow retried a failed agent. */
  attempt: number
  queuedAt: number | null
  startedAt: number | null
  durationMs: number | null
  /** When the agent last reported progress, used to age the live activity strip. */
  lastProgressAt: number | null
  tokens: number
  toolCalls: number
  lastToolName: string | null
  lastToolSummary: string | null
  /** Opening lines of the prompt the agent was given. */
  promptPreview: string | null
  /** Opening lines of what it returned. */
  resultPreview: string | null
}

/** A Workflow tool run recorded by a session. */
export interface WorkflowRun {
  runId: string
  /** The `Workflow` call that launched the run, matched on the run id it reports back. */
  callId: string | null
  name: string
  summary: string | null
  status: string
  startedAt: string
  durationMs: number | null
  agentCount: number
  totalTokens: number
  totalToolCalls: number
  phases: { title: string; detail?: string }[]
  agents: WorkflowAgent[]
  model: string | null
  /**
   * True when the run was assembled from its working directory rather than read from the
   * JSON file it writes when it ends.
   *
   * The `Workflow` tool keeps a run's shape — the label and phase it gave each agent — in
   * memory and files it only once the run is over, so a run that is still going has no
   * file to read. What it does have is a directory it is filling as it goes: a journal
   * naming every agent it started and every one that came back, and a transcript per agent
   * saying what that agent is doing right now. A run read from there is complete about the
   * present and silent about the plan — its agents are numbered rather than labelled, it
   * reports no phases, and its totals count only what has been written so far.
   */
  live: boolean
}

/** One choice Claude Code offered for a question. */
export interface AskOption {
  label: string
  /** Why you would pick this one, when the model bothered to say. */
  description?: string
  /** A sketch of what the option leads to, drawn by the model rather than by aivis. */
  preview?: string
}

/**
 * A background task a session started and has not been told the end of.
 *
 * Work handed off to run outside the turn that asked for it — a Workflow, a subagent, a
 * long shell command. The turn carries on, so nothing else about the session says this is
 * happening: its status is whatever its own thread is doing, which may be nothing at all.
 */
export interface BackgroundTask {
  /** The tool call that started it, which is what its completion notice is addressed to. */
  toolUseId: string
  /** The tool that started it, such as `Workflow` or `Bash`. */
  tool: string
  /** One line naming what it is doing, read from the call's own input. */
  detail: string | null
  /** ISO timestamp the task was started. */
  at: string
}

/**
 * One question a session is holding on, exactly as Claude Code asked it.
 *
 * The bounds are Claude Code's, not aivis's: one to four questions per call, two to four
 * options each, and a header of at most twelve characters. aivis draws what it is given
 * rather than enforcing any of that a second time.
 */
export interface AskQuestion {
  question: string
  /** Short label for the question, which is what the tab in the terminal shows. */
  header: string
  options: AskOption[]
  /** True when several options may be picked at once. */
  multiSelect: boolean
}

/**
 * A permission change Claude Code offers to make alongside an allow.
 *
 * The shapes are Claude Code's own and it is the only thing that reads them back, so an
 * accepted suggestion is returned untouched rather than modelled here.
 */
export type PermissionSuggestion = Record<string, unknown>

/**
 * A decision a driven session has stopped for, and everything needed to make it.
 *
 * Two different things arrive on one wire. A **question** is the `AskUserQuestion` tool:
 * Claude wrote the options itself and the answer is the tool's result, so there is no
 * allow or deny to give — only an answer. A **permission prompt** is any other tool
 * Claude Code decided not to run unasked, where the answer is allow or deny. Which one
 * this is shows in `questions`: present for a question, null for a permission prompt.
 */
export interface PendingAsk {
  /** Correlates the answer with the request, and is what an answer is addressed to. */
  requestId: string
  /** The tool call being held, which is what the transcript shows as still running. */
  toolUseId: string
  toolName: string
  /** The name Claude Code would print, which is not always the tool's own. */
  displayName: string
  /** The questions, when this is a question. Null for a permission prompt. */
  questions: AskQuestion[] | null
  /** What the tool was asked to do, for a permission prompt. Null for a question. */
  input: Record<string, unknown> | null
  /** One line naming the subject of a permission prompt, such as the file or command. */
  description: string | null
  /** Why Claude Code decided to ask rather than run it, when it said. */
  reason: string | null
  /** Permission changes offered alongside an allow, such as switching the session's mode. */
  suggestions: PermissionSuggestion[]
  /** ISO timestamp the request arrived, which is when the wait started. */
  at: string
}

/**
 * An answer to one pending ask.
 *
 * `answers` maps each question's own text to what was chosen — Claude Code keys them that
 * way, not by index — and carries either an option's label, several labels for a
 * multi-select, or whatever was typed instead. `suggestions` accepts the permission
 * changes the prompt offered, which is what stops it asking the same thing again.
 */
export type AskDecision =
  | { behavior: 'allow'; answers?: Record<string, string | string[]>; suggestions?: boolean }
  | { behavior: 'deny'; message?: string }

/**
 * A session's pending question, reduced to what the index needs in order to say so.
 *
 * This says a question exists; it does not say how to answer one. It is read from the
 * transcript, so every session has it — including one running in a terminal, which aivis
 * can report on but not answer for. The answerable form is `DriverStatus.asks`, which
 * carries the request id an answer is addressed to and exists only for a driven session.
 *
 * The whole question is not carried on every fleet update: a screenful of options and
 * previews per session would dwarf everything else in the snapshot, and the index only
 * ever draws one line of it.
 */
export interface AskSummary {
  /** The held tool call, which is what makes this wait distinct from the next one. */
  toolUseId: string
  /** Header of the first question, which is the shortest true label for the ask. */
  header: string
  /** The first question, in full. */
  question: string
  /** How many questions came in the one call. */
  count: number
  /** ISO timestamp the question was asked. */
  at: string
}

/** What the aivis daemon is doing with a session it drives. */
export type DriverState = 'starting' | 'idle' | 'working' | 'exited' | 'error'

/** Live status of the driver attached to one session. */
export interface DriverStatus {
  sessionId: string
  state: DriverState
  /** Reason the driver stopped or failed, when there is one. */
  detail: string | null
  /** Messages accepted but not yet answered. */
  queued: number
  permissionMode: string
  /**
   * Decisions the session has stopped for, oldest first.
   *
   * Usually empty, and usually one when it is not. Claude Code can put several tool calls
   * in flight at once, so nothing here assumes a single outstanding ask.
   */
  asks: PendingAsk[]
}

/** One rate-limit window and what was spent inside it. */
export interface Block {
  startedAt: string
  endsAt: string
  tokens: number
  /** True while now falls inside the window. */
  active: boolean
  /** Milliseconds left in the window, zero once it has closed. */
  remainingMs: number
}

/** One rate-limit window exactly as Claude Code reports it. */
export interface ReportedLimit {
  /**
   * Percentage of the quota used, straight from Claude Code.
   *
   * Null once the window the capture described has ended: a new one has begun and its
   * usage started again from nothing, so the figure that was captured no longer describes
   * anything. The clock beside it is still right, because the windows run back to back.
   */
  usedPercent: number | null
  /** ISO timestamp when the window resets. */
  resetsAt: string
  /** Milliseconds until the reset, zero once it has passed. */
  remainingMs: number
  /**
   * True when the reset in the capture had already passed and the window was rolled
   * forward onto the current one, which is what makes `usedPercent` unknown.
   */
  rolledOver: boolean
}

/**
 * Rate-limit state captured from Claude Code itself.
 *
 * These are the real numbers the CLI's status line shows. They reach aivis only because
 * the status line writes them out — nothing else on disk records them.
 */
export interface ReportedUsage {
  fiveHour: ReportedLimit | null
  sevenDay: ReportedLimit | null
  /** ISO timestamp of the capture. */
  capturedAt: string
  /** True when the capture is old enough that the percentage may have moved on. */
  stale: boolean
}

/** Current block usage: the reported truth when available, and the derived fallback. */
export interface BlockUsage {
  /**
   * What Claude Code reports, when the status line has published it. This is authoritative
   * and is what the meter shows; everything below is the fallback for when it has not.
   */
  reported: ReportedUsage | null
  current: Block | null
  /** Ceiling for the bar: a configured limit, or the busiest recent block. */
  ceilingTokens: number
  /**
   * True when the ceiling is the busiest recent block rather than a real plan limit,
   * which makes the percentage a comparison against your own history, not a quota.
   */
  ceilingIsObserved: boolean
  blockHours: number
  recent: Block[]
  /** Tokens recorded since local midnight. */
  todayTokens: number
}

/** A file offered for an `@` reference. */
export interface FileHit {
  /** Path relative to the session's working directory. */
  path: string
  name: string
  /** Directory the file sits in, empty at the root. */
  dir: string
}

/** A skill or slash command offered for a `/` reference. */
export interface CommandHit {
  /** What the user types after the slash, e.g. `graphify` or `gsd:plan-phase`. */
  name: string
  /** One-line description for the menu. */
  description: string
  /** What kind of thing this is. */
  kind: 'skill' | 'command' | 'builtin'
  /** Where it came from: `user`, `project`, `plugin:<name>`, or `terminal`. */
  source: string
  /**
   * True when aivis can expand it and deliver it into the session. Built-in terminal
   * commands are false: they are actions of the terminal client, not messages, so they
   * are shown for discoverability but cannot be run from aivis.
   */
  runnable: boolean
  /** Hint about expected arguments, from the command's frontmatter, when it has one. */
  argHint?: string
}

/** What `/api/sessions/:id/commands` returns for the `/` menu. */
export interface CommandSearch {
  /**
   * Skills, slash commands, and built-ins ranked together, best match first. Built-ins carry
   * `runnable: false` and a `terminal` source, so the client can badge them while keeping
   * them in the same list.
   */
  hits: CommandHit[]
}

/**
 * What a change list is measured against.
 *
 * `start` is the last commit made before the session began, which is what still answers
 * "what did this session change" after the session has committed its own work. `head` is
 * the uncommitted work alone. `session` is the session's own file-editing tool calls,
 * which is the only base that needs no repository at all.
 */
export type ChangeBase = 'start' | 'head' | 'session'

/** What happened to one file. */
export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed'

/** One file the working tree changed, as git reports it. */
export interface ChangedFile {
  /** Path relative to the session's working directory. */
  path: string
  status: ChangeStatus
  added: number
  removed: number
  /** Where a renamed file came from, else null. */
  oldPath: string | null
  /** Rename similarity as a percentage, when git reported one. */
  similarity: number | null
  /** True when git counted no lines because the file is binary. */
  binary: boolean
  /** True when the file is not in the index, so all of it is new. */
  untracked: boolean
}

/** The files that changed in a working directory, against one base. */
export interface ChangeSet {
  base: ChangeBase
  isRepo: boolean
  branch: string | null
  /** Abbreviated sha the diff is taken against, or null when there is no commit yet. */
  baseCommit: string | null
  baseSubject: string | null
  /** ISO commit date of the base. */
  baseAt: string | null
  /**
   * True when no commit predates the session, so `start` fell back to `HEAD`. The list is
   * then the uncommitted work, which is stated rather than passed off as the wider answer.
   */
  baseFellBack: boolean
  files: ChangedFile[]
  /** Files git left uncounted because the untracked list was cut short. */
  untrackedCapped: boolean
  error: string | null
}

/** One line inside a git hunk, carrying the numbers on both sides. */
export interface HunkLine {
  kind: 'ctx' | 'add' | 'del'
  /** Line number before the change, null on an added line. */
  oldN: number | null
  /** Line number after the change, null on a removed line. */
  newN: number | null
  text: string
}

/** One `@@` block of a unified diff. */
export interface DiffHunk {
  /** The `@@ −41,7 +41,12 @@` marker itself. */
  header: string
  /** Whatever git printed after the marker, usually the enclosing function. */
  context: string
  lines: HunkLine[]
  added: number
  removed: number
}

/** The diff of one file, as git computes it. */
export interface FileChange {
  path: string
  hunks: DiffHunk[]
  binary: boolean
  /** True when the diff was cut short because the file changed enormously. */
  truncated: boolean
  /** Lines of context asked for, so the client can ask for more. */
  context: number
  error: string | null
}

/**
 * Why an item is sitting in the attention queue.
 *
 * `asking` is a session that put a question to you and stopped for the answer, which is
 * the one kind that names its own reason rather than being inferred from silence.
 * `waiting` is a live session that has finished its turn and is holding for your reply.
 * `stalled` is a live session whose transcript stopped advancing mid-turn, which usually
 * means it is at a permission prompt or inside a long command.
 */
export type AttentionKind = 'asking' | 'waiting' | 'stalled'

/**
 * One thing waiting on you, with everything needed to act on it without leaving the page.
 *
 * The wording is left to the client: the server states what is true — which session, what
 * it last called, how long it has been waiting — and the index decides how to say it.
 */
export interface AttentionItem {
  /**
   * Stable across refreshes but not across state changes, so dismissing an item hides
   * that wait and not the next one: a session that moves on and stops again comes back.
   */
  id: string
  kind: AttentionKind
  sessionId: string
  projectName: string
  cwd: string
  /** The session's own title, which is its opening prompt. */
  title: string
  /** The tool it last called, when it has called one. */
  toolName: string | null
  toolDetail: string | null
  /** ISO timestamp from which it has been waiting on you. */
  since: string
  /** Present on `asking` items: what the session stopped for. */
  ask: AskSummary | null
  /**
   * On an `asking` item, what kind of answer it wants.
   *
   * `question` is Claude's own multiple choice, where the answer is the whole point.
   * `permission` is a tool Claude Code would not run unasked, where allow and deny are the
   * only answers there are. The index says which, because they are not the same errand.
   */
  askKind: 'question' | 'permission' | null
  /**
   * True when aivis drives this session, so the answer can be given from the browser.
   *
   * A session running in a terminal reaches this queue too — the question is read from its
   * transcript like everything else — but its dialogue belongs to that terminal, so the row
   * offers to open it rather than promising a card that will not be there.
   */
  answerable: boolean
}

/** What `/api/attention` returns: everything waiting on you, longest wait first. */
export interface AttentionQueue {
  items: AttentionItem[]
  scannedAt: string
}

/**
 * The model a session inherits when the new-session sheet is left on `default`.
 *
 * `value` is the raw setting, so it may be an alias such as `opus[1m]` rather than a full
 * id. `source` names the file it came from, which is the part that makes the answer
 * checkable: a default nobody can trace to a file is just another unexplained word.
 */
export interface DefaultModel {
  value: string | null
  source: string | null
}

/** What `/api/defaults` returns: what a new session inherits, and what the words mean. */
export interface Defaults {
  model: DefaultModel
  /** How long a live session may go without writing before it counts as `stalled`. */
  staleAfterMs: number
  /** How recently an `idle` session must have stopped to be queued as waiting on you. */
  waitingWindowMs: number
  /** How long a session stays `parked` before it drops back to `ended`. */
  parkTtlDays: number
  /**
   * Why a `!` line will not run here, or `null` when it will.
   *
   * The composer asks once rather than finding out by failing, so a bind where `!` is
   * refused says so on the `!` you are still typing instead of after you press enter.
   */
  bashRefusal: string | null
}
