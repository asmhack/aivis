import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  ActivitySummary,
  AgentToolCall,
  Subagent,
  TranscriptPage,
  WorkflowAgent,
  WorkflowRun,
} from '../shared/types.ts'
import { readTranscript } from './transcriptView.ts'

/**
 * Reads the parent transcript, at most once, and only if something asks for it.
 *
 * Both lists here link back into the parent — an agent to the `Agent` call that launched it,
 * a run to its `Workflow` call — and the two are answered in the same request, so they share
 * one read. It stays lazy because a session with neither pays for neither.
 */
export type ReadParent = () => Promise<TranscriptPage>

export function parentReader(transcriptPath: string, sessionId: string): ReadParent {
  let once: Promise<TranscriptPage> | undefined
  return () => (once ??= readTranscript(transcriptPath, sessionId, 50_000))
}

/** Transcripts of a session's subagents live beside it, in a directory named for the session. */
function sessionDir(transcriptPath: string): string {
  return transcriptPath.replace(/\.jsonl$/, '')
}

interface RawRecord {
  type?: string
  timestamp?: string
  message?: { role?: string; model?: string; content?: unknown; usage?: Record<string, number> }
}

interface Block {
  type?: string
  text?: string
  name?: string
  id?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : clean.slice(0, max - 1) + '…'
}

function describe(input: Record<string, unknown> | undefined): string {
  const keys = ['command', 'file_path', 'pattern', 'description', 'url', 'query', 'skill', 'prompt']
  for (const key of keys) {
    const value = input?.[key]
    if (typeof value === 'string' && value) return truncate(value, 80)
  }
  return ''
}

interface TaskLink {
  callId: string
  description: string | null
  agentType: string | null
  failed: boolean
}

/**
 * Link each subagent to the task it was given, and to the call that gave it.
 *
 * A subagent transcript records its own id but not the description the parent gave it.
 * The parent's `Agent` tool result echoes the agent id, so scanning the parent's tool
 * calls maps an id back to the description, the agent type, and the call itself. The
 * whole parent is read, so an agent from early in a long session is named as readily as
 * one that started a minute ago.
 */
async function taskDescriptions(readParent: ReadParent): Promise<Map<string, TaskLink>> {
  const result = new Map<string, TaskLink>()
  try {
    const page = await readParent()
    for (const entry of page.entries) {
      if (entry.kind !== 'tool' || entry.call.name !== 'Agent' || !entry.call.result) continue
      const id = entry.call.result.match(/\b([0-9a-f]{17})\b/)?.[1]
      if (!id) continue
      const input = entry.call.input
      result.set(id, {
        callId: entry.call.id,
        description: typeof input.description === 'string' ? input.description : null,
        agentType: typeof input.subagent_type === 'string' ? input.subagent_type : null,
        failed: entry.call.isError,
      })
    }
  } catch {
    // A parent that cannot be read just means agents show without their descriptions.
  }
  return result
}

/**
 * Map each workflow run id back to the `Workflow` call that started it.
 *
 * The call's result names the run — its transcript directory, its script file, and a plain
 * `Run ID:` line all carry the same `wf_…` token — so sweeping the result for that token
 * links the two without the run file having to know anything about the conversation.
 */
async function workflowCalls(readParent: ReadParent): Promise<Map<string, WorkflowCall>> {
  const result = new Map<string, WorkflowCall>()
  try {
    const page = await readParent()
    for (const entry of page.entries) {
      if (entry.kind !== 'tool' || entry.call.name !== 'Workflow' || !entry.call.result) continue
      for (const match of entry.call.result.matchAll(/\bwf_[A-Za-z0-9_-]+/g)) {
        result.set(match[0], { callId: entry.call.id, at: entry.at })
      }
    }
  } catch {
    // A parent that cannot be read just means a run shows without its launching call.
  }
  return result
}

/**
 * The call that started a run, and when it was made.
 *
 * The time matters for a run still going: its agents' transcripts say when each of them
 * started, which is not when the run did, and a capped read of a long agent does not even
 * say that — it says when the part that was read begins.
 */
interface WorkflowCall {
  callId: string
  at: string
}

/**
 * List the subagents a session has launched, newest activity first.
 *
 * An agent counts as running while its transcript has advanced within `staleAfterMs`
 * and the parent session itself is alive; there is no completion marker in the file.
 */
export async function listSubagents(
  transcriptPath: string,
  opts: { parentAlive: boolean; staleAfterMs: number },
  readParent: ReadParent,
): Promise<Subagent[]> {
  const dir = path.join(sessionDir(transcriptPath), 'subagents')
  let files: string[]
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f))
  } catch {
    return []
  }
  if (files.length === 0) return []

  const descriptions = await taskDescriptions(readParent)
  const agents: Subagent[] = []

  for (const file of files) {
    const agent = await readSubagent(file, opts)
    if (!agent) continue
    const meta = descriptions.get(agent.agentId)
    agents.push({
      ...agent,
      callId: meta?.callId ?? null,
      description: meta?.description ?? null,
      agentType: meta?.agentType ?? null,
      status: meta?.failed ? 'failed' : agent.status,
    })
  }

  return agents.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
}

/**
 * The last `cap` bytes of an agent transcript, starting at a record boundary.
 *
 * Agent transcripts run to hundreds of megabytes, and everything read from one here is
 * about its recent state, so the tail is enough. The partial first line is dropped, which
 * is why the opening prompt can be missing and the first surviving message stands in.
 *
 * Only the bytes the read actually returned are decoded, and the loop asks again for the
 * rest. The buffer is uninitialised, so decoding all of it handed `records()` whatever was
 * left in that memory the moment a read came up short — which is what a file truncated
 * between the stat and the read does, and a journal being appended to by a running workflow
 * is re-read here on a timer. Any of that garbage which happened to parse as JSON became a
 * prompt, a tool detail or a result preview that this process then served over HTTP.
 */
async function readTail(file: string, cap = 2 * 1024 * 1024): Promise<string | null> {
  try {
    const stat = await fs.stat(file)
    const handle = await fs.open(file, 'r')
    try {
      const start = Math.max(0, stat.size - cap)
      const want = stat.size - start
      const buffer = Buffer.allocUnsafe(want)
      let filled = 0
      while (filled < want) {
        const { bytesRead } = await handle.read(buffer, filled, want - filled, start + filled)
        // Nothing more to give: the file shrank after it was measured. Whatever was read
        // stands, and the next pass reads the smaller file from its own end.
        if (bytesRead <= 0) break
        filled += bytesRead
      }
      const text = buffer.subarray(0, filled).toString('utf8')
      // With nothing read there is no newline to find, and `indexOf` answers -1, so the
      // slice below starts at 0 and yields the empty string — which is the right answer.
      return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/**
 * Walk a JSON-per-line file's records, skipping lines that do not parse.
 *
 * Transcripts are what this mostly reads, so that is the shape it assumes; a run's journal
 * is the same format carrying something else, and says so by naming its own.
 */
function* records<T = RawRecord>(text: string): Generator<T> {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      yield JSON.parse(line) as T
    } catch {
      continue
    }
  }
}

/** Results longer than this are cut, matching what the conversation view keeps. */
const MAX_RESULT_CHARS = 4000

/**
 * The tool calls one agent made, newest last, each with its input and its result.
 *
 * The rail's activity stream used to be names and one-line summaries, because that is all
 * a list needs. Opening a call to see what it actually ran and what came back means
 * pairing each `tool_use` with the `tool_result` that answers it, which only this file has.
 */
export async function readAgentTools(
  transcriptPath: string,
  agentId: string,
  limit = 60,
): Promise<AgentToolCall[]> {
  const file = path.join(sessionDir(transcriptPath), 'subagents', `agent-${agentId}.jsonl`)
  const text = await readTail(file)
  if (text === null) return []

  const calls: AgentToolCall[] = []
  const byId = new Map<string, AgentToolCall>()

  for (const rec of records(text)) {
    const content = rec.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Block[]) {
      if (block.type === 'tool_use' && block.id && block.name) {
        const call: AgentToolCall = {
          id: block.id,
          tool: block.name,
          detail: describe(block.input),
          at: rec.timestamp ?? '',
          input: block.input ?? {},
          result: null,
          isError: false,
          resultTruncated: false,
        }
        calls.push(call)
        byId.set(call.id, call)
        continue
      }
      if (block.type !== 'tool_result' || !block.tool_use_id) continue
      const call = byId.get(block.tool_use_id)
      if (!call) continue
      const full = resultText(block.content)
      call.result = full.slice(0, MAX_RESULT_CHARS)
      call.resultTruncated = full.length > MAX_RESULT_CHARS
      call.isError = block.is_error === true
    }
  }

  return calls.slice(-limit)
}

/** A tool result arrives either as plain text or as a list of text blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content === undefined ? '' : JSON.stringify(content)
  return content
    .map((part) => (typeof part === 'string' ? part : ((part as Block).text ?? '')))
    .join('\n')
}

async function readSubagent(
  file: string,
  opts: {
    parentAlive: boolean
    staleAfterMs: number
    /** How much of the tail to read, for a caller reading many agents at once. */
    tailBytes?: number
  },
): Promise<Subagent | null> {
  const agentId = path.basename(file, '.jsonl').replace(/^agent-/, '')
  const text = await readTail(file, opts.tailBytes)
  if (text === null) return null

  let prompt = ''
  let startedAt = ''
  let lastActivityAt = ''
  let assistantTurns = 0
  let toolCalls = 0
  let outputTokens = 0
  let tokens = 0
  let contextTokens = 0
  let model: string | null = null
  let notes: string | null = null
  const recentTools: ActivitySummary[] = []
  let lastActivity: ActivitySummary | null = null

  for (const rec of records(text)) {
    if (rec.timestamp) {
      if (!startedAt) startedAt = rec.timestamp
      lastActivityAt = rec.timestamp
    }
    const content = rec.message?.content
    const blocks: Block[] = Array.isArray(content) ? (content as Block[]) : []

    if (rec.type === 'user' && !prompt) {
      const body =
        typeof content === 'string'
          ? content
          : blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
      if (body.trim()) prompt = truncate(body, 200)
    }

    if (rec.type === 'assistant') {
      assistantTurns += 1
      const usage = rec.message?.usage
      outputTokens += usage?.output_tokens ?? 0
      tokens +=
        (usage?.input_tokens ?? 0) +
        (usage?.output_tokens ?? 0) +
        (usage?.cache_read_input_tokens ?? 0) +
        (usage?.cache_creation_input_tokens ?? 0)
      // The last turn's own prompt, which is what the agent was holding rather than what it
      // has spent. Only a turn that reported usage counts, so a record without it does not
      // reset the figure to nothing.
      if (usage) {
        contextTokens =
          (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0)
      }
      if (rec.message?.model) model = rec.message.model

      const prose = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n')
        .trim()
      if (prose) notes = prose

      const tools = blocks.filter((b) => b.type === 'tool_use')
      toolCalls += tools.length
      for (const tool of tools) {
        if (!tool.name) continue
        const summary: ActivitySummary = {
          tool: tool.name,
          detail: describe(tool.input),
          at: rec.timestamp ?? lastActivityAt,
        }
        recentTools.push(summary)
        // Only the tail is shown, and holding the whole history would grow without bound.
        if (recentTools.length > 40) recentTools.shift()
        lastActivity = summary
      }
    }
  }

  if (!lastActivityAt) return null
  const fresh = Date.now() - new Date(lastActivityAt).getTime() < opts.staleAfterMs

  return {
    agentId,
    // Filled in by the caller, which is what reads the parent and can match the call.
    callId: null,
    description: null,
    agentType: null,
    prompt,
    startedAt: startedAt || lastActivityAt,
    lastActivityAt,
    assistantTurns,
    toolCalls,
    outputTokens,
    tokens,
    contextTokens,
    model,
    lastActivity,
    recentTools,
    notes,
    status: opts.parentAlive && fresh ? 'running' : 'done',
  }
}

/**
 * List the Workflow tool runs a session has recorded, newest first.
 *
 * A run is read from the JSON file it writes when it ends, and a run that has not ended has
 * no such file — which used to mean that the one run you would actually want to watch was
 * the one run aivis could not see. So the runs that have filed are read from their files,
 * and anything left with a working directory and no file is assembled from that directory
 * instead. See `WorkflowRun.live` for what the difference costs.
 */
export async function listWorkflows(
  transcriptPath: string,
  opts: {
    parentAlive: boolean
    staleAfterMs: number
    /**
     * Tool calls the session has made and not been told the end of.
     *
     * A run's own directory cannot say whether the run is over, and the session's transcript
     * can: this is where the `Workflow` calls with no completion notice arrive from.
     */
    outstanding?: Iterable<string>
  },
  /** Omit where only the runs matter, not the call that launched each one: linking costs a read. */
  readParent?: ReadParent,
): Promise<WorkflowRun[]> {
  const dir = path.join(sessionDir(transcriptPath), 'workflows')
  let files: string[] = []
  try {
    files = (await fs.readdir(dir)).filter((f) => f.startsWith('wf_') && f.endsWith('.json'))
  } catch {
    // A session that has filed no run may still have one going, so this is not the end of it.
  }

  const calls = readParent ? await workflowCalls(readParent) : new Map<string, WorkflowCall>()
  const runs: WorkflowRun[] = []
  for (const name of files) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as Record<string, unknown>
      const progress = Array.isArray(raw.workflowProgress) ? raw.workflowProgress : []
      const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
      const agents = progress
        .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
        .filter((p) => p.type === 'workflow_agent')
        .map((p, i) => ({
          index: Number(p.index ?? i + 1),
          label: String(p.label ?? ''),
          phaseIndex: Number(p.phaseIndex ?? 0),
          phaseTitle: String(p.phaseTitle ?? ''),
          agentId: text(p.agentId),
          model: text(p.model),
          state: String(p.state ?? 'unknown'),
          attempt: Number(p.attempt ?? 1),
          queuedAt: typeof p.queuedAt === 'number' ? p.queuedAt : null,
          startedAt: typeof p.startedAt === 'number' ? p.startedAt : null,
          durationMs: typeof p.durationMs === 'number' ? p.durationMs : null,
          lastProgressAt: typeof p.lastProgressAt === 'number' ? p.lastProgressAt : null,
          tokens: Number(p.tokens ?? 0),
          toolCalls: Number(p.toolCalls ?? 0),
          lastToolName: text(p.lastToolName),
          lastToolSummary: text(p.lastToolSummary),
          promptPreview: text(p.promptPreview),
          resultPreview: text(p.resultPreview),
        }))
        .sort((a, b) => a.index - b.index)

      const runId = String(raw.runId ?? name.replace(/\.json$/, ''))
      runs.push({
        runId,
        callId: calls.get(runId)?.callId ?? null,
        name: String(raw.workflowName ?? 'workflow'),
        summary: typeof raw.summary === 'string' ? raw.summary : null,
        status: String(raw.status ?? 'unknown'),
        startedAt:
          typeof raw.timestamp === 'string'
            ? raw.timestamp
            : new Date(Number(raw.startTime ?? 0)).toISOString(),
        durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : null,
        agentCount: Number(raw.agentCount ?? agents.length),
        totalTokens: Number(raw.totalTokens ?? 0),
        totalToolCalls: Number(raw.totalToolCalls ?? 0),
        phases: Array.isArray(raw.phases) ? (raw.phases as { title: string; detail?: string }[]) : [],
        agents,
        model: typeof raw.defaultModel === 'string' ? raw.defaultModel : null,
        live: false,
      })
    } catch {
      // A workflow file still being written is skipped until it parses.
    }
  }

  // The file above is written when a run ends, so a working directory with no file beside it
  // is a run that has not ended: one going on right now, or one whose session was killed
  // under it. Both are worth showing and neither appears in the listing above.
  const filed = new Set(runs.map((run) => run.runId))
  const outstanding = new Set(opts.outstanding ?? [])
  for (const runId of await unfiledRuns(transcriptPath, filed)) {
    const run = await liveRun(transcriptPath, runId, calls.get(runId) ?? null, outstanding, opts)
    if (run) runs.push(run)
  }

  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

/** Where a run's agents write while it runs: one directory per run, beside the subagents. */
function runsDir(transcriptPath: string): string {
  return path.join(sessionDir(transcriptPath), 'subagents', 'workflows')
}

/**
 * How much of a live run is read, which is the whole cost of watching one.
 *
 * A finished run is one JSON file; a live one is a directory of agent transcripts, and a
 * real 88-agent run's directory is nine megabytes. The page watching a run refetches it
 * every few seconds, so both bounds matter: the agents still going are the ones the cap
 * must never cut, since they are the whole reason to look, and the tail of a transcript is
 * where what that agent is doing now is written.
 */
const LIVE_AGENT_CAP = 40
const LIVE_TAIL_BYTES = 256 * 1024

/** The largest journal read whole. The biggest in a real store is 1.5 MB. */
const JOURNAL_MAX_BYTES = 4 * 1024 * 1024

/**
 * How many runs are assembled from their directories in one read.
 *
 * A session ordinarily has one such run — the one going on right now — and collects the
 * rest one killed run at a time. Since each costs a directory of transcripts and this is
 * read on a timer while a run is live, the oldest give way rather than the request growing
 * with everything the session ever abandoned.
 */
const LIVE_RUN_CAP = 8

/** Run directories with no filed JSON, which is what a run that has not ended looks like. */
async function unfiledRuns(transcriptPath: string, filed: Set<string>): Promise<string[]> {
  const dir = runsDir(transcriptPath)
  let names: string[]
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    names = entries
      .filter((e) => e.isDirectory() && e.name.startsWith('wf_') && !filed.has(e.name))
      .map((e) => e.name)
  } catch {
    return []
  }
  if (names.length <= 1) return names

  // Newest first, so the cap falls on runs that stopped writing longest ago.
  const dated = await Promise.all(
    names.map(async (name) => {
      try {
        return { name, at: (await fs.stat(path.join(dir, name))).mtimeMs }
      } catch {
        return { name, at: 0 }
      }
    }),
  )
  return dated.sort((a, b) => b.at - a.at).slice(0, LIVE_RUN_CAP).map((entry) => entry.name)
}

/** What a run's journal records: every agent it started, and what the finished ones returned. */
interface Journal {
  /** Agent ids in the order the run started them, which is the only ordering it records. */
  order: string[]
  /** Opening extract of each finished agent's result, keyed by agent id. */
  results: Map<string, string>
}

/**
 * Read a run's journal.
 *
 * The journal is a resume log rather than a progress report: the run appends a line when it
 * starts an agent and another when one comes back, keyed by a hash of the work so that a
 * resumed run can skip whatever is already done. Progress is not what it was written for,
 * but started minus returned is exactly how far along a run is, and it costs one read.
 */
async function readJournal(dir: string): Promise<Journal> {
  const journal: Journal = { order: [], results: new Map() }
  const text = await readTail(path.join(dir, 'journal.jsonl'), JOURNAL_MAX_BYTES)
  if (text === null) return journal
  const seen = new Set<string>()
  for (const entry of records<{ type?: string; agentId?: string; result?: unknown }>(text)) {
    const agentId = entry.agentId
    if (typeof agentId !== 'string' || !agentId) continue
    if (entry.type === 'started' && !seen.has(agentId)) {
      seen.add(agentId)
      journal.order.push(agentId)
    }
    if (entry.type === 'result') {
      journal.results.set(agentId, resultText(entry.result).slice(0, MAX_RESULT_CHARS))
    }
  }
  return journal
}

/** How much of a script is read looking for its meta block, which is required to be first. */
const SCRIPT_HEAD_BYTES = 4096

/**
 * The name and goal a run was launched with, read from the script it is running.
 *
 * A workflow script opens with a literal `meta` block naming the run and saying in one line
 * what it is for, and the Workflow tool writes the script beside the run before starting
 * it. While the run is going that file is the only place either is written down, so it is
 * read from the top — a bounded window, since the block has to come first. The file name
 * carries the workflow's name too, which is what a script that cannot be read falls back to.
 */
async function readScriptMeta(
  transcriptPath: string,
  runId: string,
): Promise<{ name: string | null; summary: string | null }> {
  const dir = path.join(sessionDir(transcriptPath), 'workflows', 'scripts')
  const suffix = `-${runId}.js`
  let file: string | undefined
  try {
    file = (await fs.readdir(dir)).find((name) => name.endsWith(suffix))
  } catch {
    return { name: null, summary: null }
  }
  if (!file) return { name: null, summary: null }
  const fallback = file.slice(0, -suffix.length) || null

  let head = ''
  try {
    const handle = await fs.open(path.join(dir, file), 'r')
    try {
      const buffer = Buffer.allocUnsafe(SCRIPT_HEAD_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, SCRIPT_HEAD_BYTES, 0)
      head = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return { name: fallback, summary: null }
  }
  return { name: metaField(head, 'name') ?? fallback, summary: metaField(head, 'description') }
}

/**
 * Read one string field out of a script's `meta` literal.
 *
 * The first match wins, which is the meta block's own, because nothing else in a script is
 * allowed above it. Either quote or a backtick opens the value, escapes are honoured, and
 * the alternation cannot backtrack ambiguously — one branch needs a backslash and the other
 * excludes it — so a 4 KB window costs a single pass whatever is in it.
 */
function metaField(head: string, key: string): string | null {
  const match = head.match(new RegExp(`\\b${key}:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`))
  const value = match?.[2]
  return value ? truncate(value.replace(/\\(.)/g, '$1'), 200) : null
}

/**
 * Assemble a run from the directory it is filling, for one that has not filed its JSON.
 *
 * Everything here comes from two sources that owe the reader nothing: a journal kept for
 * resuming, and the agents' own transcripts. Between them they say which agents the run
 * started, which have come back, and what each one still going is doing right now — which
 * is what watching a run is. What they cannot say is the shape the script gave it, so the
 * labels are ordinals and there are no phases to file the agents under.
 */
async function liveRun(
  transcriptPath: string,
  runId: string,
  /** The `Workflow` call that started it, which is how the session says whether it is over. */
  call: WorkflowCall | null,
  outstanding: Set<string>,
  opts: { parentAlive: boolean; staleAfterMs: number },
): Promise<WorkflowRun | null> {
  const dir = path.join(runsDir(transcriptPath), runId)
  let names: string[]
  try {
    names = (await fs.readdir(dir)).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
  } catch {
    return null
  }
  if (names.length === 0) return null

  const journal = await readJournal(dir)
  const files = new Map(names.map((name) => [name.slice('agent-'.length, -'.jsonl'.length), name]))
  // The journal's order is the run's own. An agent whose transcript exists before the
  // journal has caught up goes on the end rather than being dropped.
  const started = journal.order.filter((id) => files.has(id))
  const known = new Set(started)
  const ordered = [...started, ...[...files.keys()].filter((id) => !known.has(id))]
  const position = new Map(ordered.map((id, i) => [id, i + 1]))
  // Reading is capped, so what the cap cuts has to be the least interesting: the agents
  // still going are read first, and the ones that came back after them.
  const chosen = [...ordered]
    .sort((a, b) => Number(journal.results.has(a)) - Number(journal.results.has(b)))
    .slice(0, LIVE_AGENT_CAP)

  const read: { agentId: string; index: number; sub: Subagent; result: string | undefined }[] = []
  for (const agentId of chosen) {
    const sub = await readSubagent(path.join(dir, files.get(agentId) as string), {
      ...opts,
      tailBytes: LIVE_TAIL_BYTES,
    })
    if (!sub) continue
    read.push({
      agentId,
      index: position.get(agentId) ?? read.length + 1,
      sub,
      result: journal.results.get(agentId),
    })
  }
  if (read.length === 0) return null

  /*
   * Whether this run is still going, which its own directory cannot say: a run that was
   * killed and one that is working leave the same files behind, and a session resumed the
   * next day is alive again without any of yesterday's runs being.
   *
   * The session's transcript can say. A `Workflow` call whose completion notice has not
   * been filed is a run that has not ended, and the call that launched this run is the link
   * between the two — the same pairing the running row on the index is drawn from. Where
   * the launching call could not be matched there is only the agents themselves: one that
   * has written recently under a live session is working, whatever else is unknown.
   */
  const going =
    call !== null
      ? outstanding.has(call.callId)
      : read.some((entry) => entry.result === undefined && entry.sub.status === 'running')

  const agents: WorkflowAgent[] = []
  for (const { agentId, index, sub, result } of read) {
    const startedAt = new Date(sub.startedAt).getTime()
    const lastAt = new Date(sub.lastActivityAt).getTime()
    agents.push({
      index,
      // The label the script gave this agent is held in the run's own state, which is not
      // written until the run ends, so until then an agent is named by when it started.
      label: `agent ${index}`,
      // Nothing in the directory says which phase an agent belongs to, and the rail counts
      // a phase's agents by this field, so a live run reports no phases to count them in.
      phaseIndex: 0,
      phaseTitle: '',
      agentId,
      model: sub.model,
      // Back with a result, or not — and an agent that never came back is only still
      // working if the run itself is. Otherwise it was killed where it stood, which the
      // rail draws as a failure because that is what it is.
      state: result !== undefined ? 'done' : going ? 'running' : 'cancelled',
      attempt: 1,
      queuedAt: null,
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
      durationMs:
        result !== undefined && Number.isFinite(startedAt) && Number.isFinite(lastAt)
          ? lastAt - startedAt
          : null,
      lastProgressAt: Number.isFinite(lastAt) ? lastAt : null,
      // The figure a run files for its own agents is the context each ended up holding, so
      // that is the one read here: a live run and the same run once filed then say the same
      // thing, and a capped read does not understate it the way a running total would.
      tokens: sub.contextTokens,
      toolCalls: sub.toolCalls,
      lastToolName: sub.lastActivity?.tool ?? null,
      lastToolSummary: sub.lastActivity?.detail ?? null,
      promptPreview: sub.prompt || null,
      resultPreview: result ?? null,
    })
  }
  // Read in the order that spends the cap best, returned in the order the run started them,
  // which is how a filed run reports its own and therefore how the rail expects to find it.
  agents.sort((a, b) => a.index - b.index)

  const meta = await readScriptMeta(transcriptPath, runId)
  // When the run began, which is when the call went out rather than when the first agent
  // it started wrote its first line — and for an agent read tail-first, not even that.
  const starts = agents.map((a) => a.startedAt).filter((v): v is number => v !== null)
  const called = call ? new Date(call.at).getTime() : NaN
  const startedAt = Number.isFinite(called)
    ? called
    : starts.length > 0
      ? Math.min(...starts)
      : Date.now()
  // How long it has been going, or had been when it stopped writing.
  const progress = agents.map((a) => a.lastProgressAt).filter((v): v is number => v !== null)
  const until = going || progress.length === 0 ? Date.now() : Math.max(...progress)
  return {
    runId,
    callId: call?.callId ?? null,
    name: meta.name ?? runId,
    summary: meta.summary,
    // A run that is not going and has filed no JSON was killed rather than finished: the
    // file that would have closed it is never coming.
    status: going ? 'running' : 'stopped',
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Math.max(0, until - startedAt),
    agentCount: Math.max(journal.order.length, ordered.length),
    totalTokens: agents.reduce((total, agent) => total + agent.tokens, 0),
    totalToolCalls: agents.reduce((total, agent) => total + agent.toolCalls, 0),
    phases: [],
    agents,
    model: agents.find((agent) => agent.model)?.model ?? null,
    live: true,
  }
}
