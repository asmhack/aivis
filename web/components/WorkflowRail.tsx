import { Fragment, useMemo, useState } from 'react'
import type { WorkflowAgent, WorkflowRun } from '../../shared/types.ts'
import { duration, tokens as formatTokens } from '../format.ts'
import { useDockedSelection } from '../useDockedSelection.ts'

/**
 * Where the workflow view is pointing.
 *
 * A run of 74 agents is unreadable as one list, so it is navigated a level at a time:
 * the run shows its phases, a phase shows its tasks, and a task shows the agents that
 * ran it. `runs` only appears when a session recorded more than one run.
 */
export type WfView =
  | { level: 'runs' }
  | { level: 'run'; runId: string }
  | { level: 'phase'; runId: string; phaseIndex: number }
  | { level: 'agent'; runId: string; phaseIndex: number; taskKey: string; agentIndex: number }

/**
 * Where a workflow starts when the tab is opened.
 *
 * A run that has not finished is the one you opened the tab for, whatever else the session
 * has recorded, so it opens on that rather than on a list to pick from.
 */
export function initialView(workflows: WorkflowRun[]): WfView {
  const start = workflows.find((entry) => entry.live) ?? (workflows.length === 1 ? workflows[0] : undefined)
  return start ? { level: 'run', runId: start.runId } : { level: 'runs' }
}

type Bucket = 'done' | 'running' | 'failed' | 'queued'

/** Map the many state strings a run may record onto the four the UI draws. */
function bucketOf(agent: WorkflowAgent): Bucket {
  const state = agent.state.toLowerCase()
  if (state === 'done' || state === 'completed' || state === 'success') return 'done'
  if (state === 'running' || state === 'active' || state === 'in_progress') return 'running'
  if (state === 'failed' || state === 'error' || state === 'cancelled') return 'failed'
  return 'queued'
}

/** The status dot one agent draws. Queued and done share the resting dot: neither is moving. */
function dotFor(bucket: Bucket): string {
  if (bucket === 'failed') return 'dot--failed'
  if (bucket === 'running') return 'dot--working'
  return 'dot--ended'
}

interface Counts {
  done: number
  running: number
  failed: number
  queued: number
  total: number
}

function count(agents: WorkflowAgent[]): Counts {
  const counts: Counts = { done: 0, running: 0, failed: 0, queued: 0, total: agents.length }
  for (const agent of agents) counts[bucketOf(agent)] += 1
  return counts
}

/**
 * The task an agent belongs to, which is its label without the instance suffix.
 *
 * A workflow that fans one job across many agents labels them `verify:deadcode:0`,
 * `:1`, and so on, so dropping the trailing number groups them back together.
 */
function taskKeyOf(label: string): string {
  return label.replace(/:\d+$/, '')
}

function instanceOf(label: string): string {
  return label.match(/(:\d+)$/)?.[1] ?? ''
}

interface Task {
  key: string
  agents: WorkflowAgent[]
  counts: Counts
}

/**
 * Roll a phase's agents up into the tasks they ran, keeping the order they appear in.
 *
 * Both the phase list and the docked agent list group by task, so they group the same way.
 */
function groupTasks(agents: WorkflowAgent[]): Task[] {
  const map = new Map<string, WorkflowAgent[]>()
  for (const agent of agents) {
    const key = taskKeyOf(agent.label)
    map.set(key, [...(map.get(key) ?? []), agent])
  }
  return [...map.entries()].map(([key, list]) => ({ key, agents: list, counts: count(list) }))
}

/** Format an epoch timestamp as an age, for the live activity strip. */
function ageOf(at: number | null): string {
  if (!at) return ''
  return duration(Date.now() - at)
}

/**
 * Wall-clock span of a set of agents.
 *
 * Agents in a phase run in parallel, so summing their durations overstates the phase.
 * The span from the first start to the last finish is what actually elapsed.
 */
function span(agents: WorkflowAgent[]): number | null {
  const starts = agents.map((a) => a.startedAt).filter((v): v is number => v !== null)
  if (starts.length === 0) return null
  const ends = agents.map((a) => (a.startedAt ?? 0) + (a.durationMs ?? 0))
  return Math.max(...ends) - Math.min(...starts)
}

function sumTokens(agents: WorkflowAgent[]): number {
  return agents.reduce((total, agent) => total + agent.tokens, 0)
}

/** Fields an agent's structured result may carry, however it was cut short. */
interface ResultFields {
  /** True when the text looked like JSON, parsed or not. */
  structured: boolean
  refuted: boolean | null
  verdict: string | null
  confidence: string | null
  reasoning: string | null
  evidence: string | null
  /** True when the value was recovered from a result that stops mid-object. */
  partial: boolean
}

const EMPTY_RESULT: ResultFields = {
  structured: false,
  refuted: null,
  verdict: null,
  confidence: null,
  reasoning: null,
  evidence: null,
  partial: false,
}

function unescape(value: string): string {
  try {
    return JSON.parse(`"${value.replace(/"/g, '\\"')}"`) as string
  } catch {
    return value.replace(/\\n/g, '\n').replace(/\\"/g, '"')
  }
}

/** Pull one string field out of JSON text, tolerating a value that never closes. */
function readString(text: string, key: string): string | null {
  const match = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)("|$)`))
  if (!match?.[1]) return null
  return unescape(match[1]) + (match[2] === '"' ? '' : '…')
}

function readBool(text: string, key: string): boolean | null {
  const match = text.match(new RegExp(`"${key}"\\s*:\\s*(true|false)`))
  return match ? match[1] === 'true' : null
}

/**
 * Read an agent's result.
 *
 * A run records only an opening extract of what an agent returned, so structured output
 * usually stops part-way through the object and `JSON.parse` fails on it. Parsing is
 * tried first for the whole results, and field-by-field extraction covers the rest —
 * without it, every truncated result renders as a wall of raw JSON.
 */
function readResult(preview: string | null): ResultFields {
  if (!preview) return EMPTY_RESULT
  const text = preview.trim()
  if (!text.startsWith('{')) return { ...EMPTY_RESULT, reasoning: text }

  try {
    const value = JSON.parse(text) as Record<string, unknown>
    const str = (key: string): string | null =>
      typeof value[key] === 'string' ? (value[key] as string) : null
    return {
      structured: true,
      partial: false,
      refuted: typeof value.refuted === 'boolean' ? value.refuted : null,
      verdict: str('verdict') ?? str('status') ?? str('conclusion'),
      confidence: str('confidence'),
      reasoning: str('reasoning') ?? str('explanation') ?? str('summary'),
      evidence:
        value.evidence === undefined
          ? null
          : typeof value.evidence === 'string'
            ? value.evidence
            : JSON.stringify(value.evidence),
    }
  } catch {
    return {
      structured: true,
      partial: true,
      refuted: readBool(text, 'refuted'),
      verdict: readString(text, 'verdict') ?? readString(text, 'status'),
      confidence: readString(text, 'confidence'),
      reasoning: readString(text, 'reasoning') ?? readString(text, 'explanation'),
      evidence: readString(text, 'evidence'),
    }
  }
}

/** One-line verdict for an agent, used in task rows and sibling comparisons. */
function verdictOf(agent: WorkflowAgent): { text: string; tone: 'good' | 'bad' | 'none' } {
  if (bucketOf(agent) === 'failed') return { text: agent.lastToolSummary ?? 'failed', tone: 'bad' }
  const result = readResult(agent.resultPreview)
  if (result.refuted !== null) {
    return result.refuted
      ? { text: 'refuted', tone: 'bad' }
      : { text: 'not refuted', tone: 'good' }
  }
  if (result.verdict) return { text: result.verdict, tone: 'none' }
  if (result.reasoning) return { text: result.reasoning.slice(0, 90), tone: 'none' }
  return { text: bucketOf(agent), tone: 'none' }
}

function Bar({ counts, mini = false }: { counts: Counts; mini?: boolean }): React.JSX.Element {
  return (
    <span className={`bar ${mini ? 'bar--mini' : ''}`}>
      {counts.done > 0 ? <i className="is-done" style={{ flex: counts.done }} /> : null}
      {counts.running > 0 ? <i className="is-running" style={{ flex: counts.running }} /> : null}
      {counts.failed > 0 ? <i className="is-failed" style={{ flex: counts.failed }} /> : null}
      {counts.queued > 0 ? <i style={{ flex: counts.queued }} /> : null}
      {counts.total === 0 ? <i style={{ flex: 1 }} /> : null}
    </span>
  )
}

/** The workflows tab: a run, a phase, or a single agent, depending on the view. */
export function WorkflowRail({
  workflows,
  view,
  onView,
  onReveal,
}: {
  workflows: WorkflowRun[]
  view: WfView
  onView: (view: WfView) => void
  /** Open the `Workflow` call that launched a run, back in the conversation. */
  onReveal: (callId: string) => void
}): React.JSX.Element {
  const run = useMemo(
    () => ('runId' in view ? workflows.find((w) => w.runId === view.runId) : undefined),
    [workflows, view],
  )

  if (view.level === 'runs' || !run) {
    return (
      <div className="rail__section">
        {workflows.map((entry) => {
          const counts = count(entry.agents)
          return (
            <button
              key={entry.runId}
              className="phaserow"
              onClick={() => onView({ level: 'run', runId: entry.runId })}
            >
              <span className="phaserow__idx">
                <span className={`dot ${counts.running > 0 ? 'dot--working' : 'dot--idle'}`} />
              </span>
              <span className="phaserow__name">{entry.name}</span>
              <span className="phaserow__go">›</span>
              <span className="phaserow__bar">
                <Bar counts={counts} />
              </span>
              <span className="phaserow__meta">
                <span>{entry.agentCount} agents</span>
                {/* A run still going has recorded no elapsed time, so its agents say it. */}
                <span>{duration(entry.durationMs ?? span(entry.agents))}</span>
                <span>{formatTokens(entry.totalTokens)} tokens</span>
                <span>{entry.status}</span>
              </span>
            </button>
          )
        })}
      </div>
    )
  }

  if (view.level === 'run') return <RunLevel run={run} onView={onView} onReveal={onReveal} />
  if (view.level === 'phase') return <PhaseLevel run={run} view={view} onView={onView} />
  return <AgentDock run={run} view={view} onView={onView} />
}

/**
 * The phase's agents beside the one being read.
 *
 * The phase level rolls 60 agents into 7 task rows, which is what makes it readable, but
 * it also means the agents themselves are two clicks apart. Docked, every agent in the
 * phase is one click away and grouped under the task it ran, so comparing what three
 * verifiers said about the same claim is a matter of moving down the list.
 */
function AgentDock({
  run,
  view,
  onView,
}: {
  run: WorkflowRun
  view: Extract<WfView, { level: 'agent' }>
  onView: (view: WfView) => void
}): React.JSX.Element {
  const tasks = useMemo(
    () => groupTasks(run.agents.filter((a) => a.phaseIndex === view.phaseIndex)),
    [run.agents, view.phaseIndex],
  )
  const selected = useDockedSelection(view.agentIndex)

  return (
    <div className="split">
      <nav className="split__list" aria-label="Agents in this phase">
        {tasks.map((task) => (
          <Fragment key={task.key}>
            <p className="split__group" title={task.key}>
              {task.key} · {task.agents.length}
            </p>
            {task.agents.map((agent) => {
              const verdict = verdictOf(agent)
              const on = agent.index === view.agentIndex
              return (
                <button
                  key={agent.index}
                  ref={on ? selected : undefined}
                  className={`li ${on ? 'li--on' : ''}`}
                  onClick={() =>
                    onView({
                      level: 'agent',
                      runId: run.runId,
                      phaseIndex: view.phaseIndex,
                      taskKey: task.key,
                      agentIndex: agent.index,
                    })
                  }
                  title={`${agent.label} — ${verdict.text}`}
                >
                  <span className={`dot ${dotFor(bucketOf(agent))}`} />
                  <span className="li__id">{instanceOf(agent.label) || agent.label}</span>
                  <span className={`li__note ${verdict.tone === 'bad' ? 'li__note--fail' : ''}`}>
                    {verdict.text}
                  </span>
                </button>
              )
            })}
          </Fragment>
        ))}
      </nav>
      <div className="split__detail">
        <AgentLevel run={run} view={view} onView={onView} />
      </div>
    </div>
  )
}

/** Level one: the run and its phases. */
function RunLevel({
  run,
  onView,
  onReveal,
}: {
  run: WorkflowRun
  onView: (view: WfView) => void
  onReveal: (callId: string) => void
}): React.JSX.Element {
  const counts = count(run.agents)
  const failed = run.agents.filter((a) => bucketOf(a) === 'failed')
  const running = run.agents
    .filter((a) => bucketOf(a) === 'running')
    .sort((a, b) => (b.lastProgressAt ?? 0) - (a.lastProgressAt ?? 0))

  const goTo = (agent: WorkflowAgent): void =>
    onView({
      level: 'agent',
      runId: run.runId,
      phaseIndex: agent.phaseIndex,
      taskKey: taskKeyOf(agent.label),
      agentIndex: agent.index,
    })

  return (
    <div className="rail__section">
      <div className="run">
        <div className="run__head">
          <span className={`dot ${counts.running > 0 ? 'dot--working' : 'dot--idle'}`} />
          {run.callId ? (
            <button
              className="run__name run__name--go"
              onClick={() => onReveal(run.callId as string)}
              title="Show the Workflow call that started this run"
            >
              {run.name}
              <span className="run__go">↗</span>
            </button>
          ) : (
            <span className="run__name">{run.name}</span>
          )}
          <span className={`run__state ${counts.running > 0 ? 'run__state--working' : ''}`}>
            {counts.running > 0 ? 'running' : run.status}
          </span>
        </div>
        {run.summary ? <p className="run__goal">{run.summary}</p> : null}
        {/*
          What a run that has not filed its JSON yet cannot tell you, said once here rather
          than left to be inferred from a phase list that is empty and agents called
          `agent 4`. Everything else on this level is as true of a live run as of a finished
          one, so the reading below stands.
        */}
        {run.live ? (
          <p className="run__note">
            Read from the run's own directory while it is still going, so its agents are
            numbered by when they started and belong to no phase: the labels the script gave
            them are written only when the run ends.
          </p>
        ) : null}
        <div className="stats">
          <span className="stat">
            elapsed <b>{duration(run.durationMs ?? span(run.agents))}</b>
          </span>
          <span className="stat">
            agents{' '}
            <b>
              {counts.done + counts.failed}/{counts.total || run.agentCount}
            </b>
          </span>
          <span className="stat">
            tools <b>{run.totalToolCalls}</b>
          </span>
          <span className="stat">
            tokens <b>{formatTokens(run.totalTokens)}</b>
          </span>
          {counts.failed > 0 ? (
            <span className="stat stat--warn">
              failed <b>{counts.failed}</b>
            </span>
          ) : null}
        </div>
        <Bar counts={counts} />
        <div className="barlegend">
          <span>
            <i style={{ background: 'var(--idle)' }} />
            {counts.done} done
          </span>
          <span>
            <i style={{ background: 'var(--working)' }} />
            {counts.running} running
          </span>
          <span>
            <i style={{ background: 'var(--del)' }} />
            {counts.failed} failed
          </span>
          <span>
            <i style={{ background: 'var(--border-strong)' }} />
            {counts.queued} queued
          </span>
        </div>
      </div>

      {failed.length > 0 ? (
        <div className="fails">
          <div className="fails__head">{failed.length} failed</div>
          <div className="fails__list">
            {failed.map((agent) => (
              <button key={agent.index} className="fails__item" onClick={() => goTo(agent)}>
                {agent.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {running.slice(0, 3).map((agent) => (
        <button key={agent.index} className="live" onClick={() => goTo(agent)}>
          <span className="live__who">{agent.label}</span>
          <span className="live__what">
            {agent.lastToolName ?? 'working'}
            {agent.lastToolSummary ? ` · ${agent.lastToolSummary}` : ''}
          </span>
          <span className="live__age">{ageOf(agent.lastProgressAt)}</span>
        </button>
      ))}

      <div className="phaselist">
        {run.phases.map((phase, index) => {
          const phaseIndex = index + 1
          const agents = run.agents.filter((a) => a.phaseIndex === phaseIndex)
          const phaseCounts = count(agents)
          const tasks = new Set(agents.map((a) => taskKeyOf(a.label))).size
          return (
            <button
              key={phase.title}
              className={`phaserow ${phaseCounts.running > 0 ? 'phaserow--active' : ''}`}
              onClick={() => onView({ level: 'phase', runId: run.runId, phaseIndex })}
            >
              <span className="phaserow__idx">{phaseIndex}</span>
              <span className="phaserow__name">{phase.title}</span>
              <span className="phaserow__go">›</span>
              <span className="phaserow__bar">
                <Bar counts={phaseCounts} />
              </span>
              <span className="phaserow__meta">
                <span>
                  {phaseCounts.total} agents · {tasks} {tasks === 1 ? 'task' : 'tasks'}
                </span>
                <span>{duration(span(agents))}</span>
                <span>{formatTokens(sumTokens(agents))} tokens</span>
                {phaseCounts.running > 0 ? (
                  <span className="is-run">
                    running <b>{phaseCounts.running}</b>
                  </span>
                ) : null}
                {phaseCounts.failed > 0 ? (
                  <span className="is-fail">
                    failed <b>{phaseCounts.failed}</b>
                  </span>
                ) : null}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Level two: one phase, with its agents rolled up into tasks. */
function PhaseLevel({
  run,
  view,
  onView,
}: {
  run: WorkflowRun
  view: Extract<WfView, { level: 'phase' }>
  onView: (view: WfView) => void
}): React.JSX.Element {
  const [only, setOnly] = useState<'all' | 'failed' | 'running'>('all')
  const [find, setFind] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  const agents = run.agents.filter((a) => a.phaseIndex === view.phaseIndex)
  const counts = count(agents)
  const phase = run.phases[view.phaseIndex - 1]

  const tasks = useMemo(() => groupTasks(agents), [agents])

  const needle = find.trim().toLowerCase()
  const visible = tasks.filter((task) => {
    if (only === 'failed' && task.counts.failed === 0) return false
    if (only === 'running' && task.counts.running === 0) return false
    if (needle && !task.key.toLowerCase().includes(needle)) return false
    return true
  })

  return (
    <div className="rail__section">
      <div className="run">
        <div className="run__head">
          <span className={`dot ${counts.running > 0 ? 'dot--working' : 'dot--idle'}`} />
          <span className="run__name">
            {view.phaseIndex}. {phase?.title ?? 'phase'}
          </span>
          <span className={`run__state ${counts.running > 0 ? 'run__state--working' : ''}`}>
            {counts.running > 0 ? `${counts.running} running` : 'done'}
          </span>
        </div>
        {phase?.detail ? <p className="run__goal">{phase.detail}</p> : null}
        <div className="stats">
          <span className="stat">
            elapsed <b>{duration(span(agents))}</b>
          </span>
          <span className="stat">
            agents{' '}
            <b>
              {counts.done + counts.failed}/{counts.total}
            </b>
          </span>
          <span className="stat">
            tokens <b>{formatTokens(sumTokens(agents))}</b>
          </span>
          {counts.failed > 0 ? (
            <span className="stat stat--warn">
              failed <b>{counts.failed}</b>
            </span>
          ) : null}
        </div>
        <Bar counts={counts} />
      </div>

      <div className="filters">
        <button
          className={`filters__chip ${only === 'all' ? 'filters__chip--on' : ''}`}
          onClick={() => setOnly('all')}
        >
          all {tasks.length}
        </button>
        <button
          className={`filters__chip filters__chip--fail ${only === 'failed' ? 'filters__chip--on' : ''}`}
          onClick={() => setOnly(only === 'failed' ? 'all' : 'failed')}
          disabled={counts.failed === 0}
        >
          failed {counts.failed}
        </button>
        <button
          className={`filters__chip ${only === 'running' ? 'filters__chip--on' : ''}`}
          onClick={() => setOnly(only === 'running' ? 'all' : 'running')}
          disabled={counts.running === 0}
        >
          running {counts.running}
        </button>
        <input
          className="filters__find"
          placeholder="find agent…"
          value={find}
          onChange={(event) => setFind(event.target.value)}
        />
      </div>

      <div className="tasklist">
        {visible.map((task) => {
          const expanded = open === task.key
          const single = task.agents.length === 1 && task.agents[0]
          return (
            <div key={task.key} className={`task ${task.counts.failed > 0 ? 'task--fail' : ''}`}>
              <button
                className="task__row"
                onClick={() =>
                  single
                    ? onView({
                        level: 'agent',
                        runId: run.runId,
                        phaseIndex: view.phaseIndex,
                        taskKey: task.key,
                        agentIndex: single.index,
                      })
                    : setOpen(expanded ? null : task.key)
                }
              >
                <span className="task__name">{task.key}</span>
                <span className="task__n">
                  {task.agents.length} {task.agents.length === 1 ? 'agent' : 'agents'}
                </span>
                <Bar counts={task.counts} mini />
                <span className="task__go">{single ? '›' : expanded ? '▾' : '▸'}</span>
              </button>
              {expanded && !single ? (
                <div className="insts">
                  {task.agents.map((agent) => {
                    const verdict = verdictOf(agent)
                      return (
                      <button
                        key={agent.index}
                        className="inst"
                        onClick={() =>
                          onView({
                            level: 'agent',
                            runId: run.runId,
                            phaseIndex: view.phaseIndex,
                            taskKey: task.key,
                            agentIndex: agent.index,
                          })
                        }
                      >
                        <span className={`dot ${dotFor(bucketOf(agent))}`} />
                        <span className="inst__id">{instanceOf(agent.label) || agent.label}</span>
                        <span className="inst__verdict">{verdict.text}</span>
                        <span className="inst__num">{duration(agent.durationMs)}</span>
                      </button>
                    )
                  })}
                </div>
              ) : null}
            </div>
          )
        })}
        {visible.length === 0 ? <p className="rail__note">No task matches that filter.</p> : null}
      </div>
    </div>
  )
}

/** Level three: one agent, with its result parsed into fields and its siblings alongside. */
function AgentLevel({
  run,
  view,
  onView,
}: {
  run: WorkflowRun
  view: Extract<WfView, { level: 'agent' }>
  onView: (view: WfView) => void
}): React.JSX.Element {
  const siblings = run.agents.filter(
    (a) => a.phaseIndex === view.phaseIndex && taskKeyOf(a.label) === view.taskKey,
  )
  const agent = siblings.find((a) => a.index === view.agentIndex) ?? siblings[0]
  if (!agent) return <p className="rail__note">That agent is no longer in the run.</p>

  const at = siblings.findIndex((a) => a.index === agent.index)
  const step = (delta: number): void => {
    const next = siblings[at + delta]
    if (next) onView({ ...view, agentIndex: next.index })
  }

  const result = readResult(agent.resultPreview)
  const verdict = verdictOf(agent)
  const { confidence, reasoning, evidence } = result

  return (
    <div className="detail">
      <div className="detail__head">
        <span className={`dot ${dotFor(bucketOf(agent))}`} />
        <span className="detail__name">{agent.label}</span>
        <span className="detail__state">{agent.state}</span>
      </div>

      <div className="stats">
        {agent.model ? (
          <span className="stat">
            model <b>{agent.model.replace(/^claude-/, '').replace(/-\d{8}$/, '')}</b>
          </span>
        ) : null}
        <span className="stat">
          ran <b>{duration(agent.durationMs)}</b>
        </span>
        <span className="stat">
          tools <b>{agent.toolCalls}</b>
        </span>
        <span className="stat">
          tokens <b>{formatTokens(agent.tokens)}</b>
        </span>
        {agent.attempt > 1 ? (
          <span className="stat stat--warn">
            attempt <b>{agent.attempt}</b>
          </span>
        ) : null}
      </div>

      <div className="fields">
        <div className="field">
          <span className="field__label">Verdict</span>
          <span className="field__value">
            <span
              className={`pill ${
                verdict.tone === 'good' ? 'pill--good' : verdict.tone === 'bad' ? 'pill--bad' : ''
              }`}
            >
              {verdict.text}
            </span>
          </span>
        </div>
        {confidence ? (
          <div className="field">
            <span className="field__label">Confidence</span>
            <span className="field__value">
              <span className={`pill ${confidence === 'high' ? 'pill--high' : ''}`}>{confidence}</span>
            </span>
          </div>
        ) : null}
        {reasoning ? (
          <div className="field field--wide">
            <span className="field__label">Reasoning</span>
            <span className="field__value">{reasoning}</span>
          </div>
        ) : null}
        {evidence ? (
          <div className="field field--wide">
            <span className="field__label">Evidence</span>
            <span className="field__value">
              <code>{evidence}</code>
            </span>
          </div>
        ) : null}
        {agent.lastToolName ? (
          <div className="field">
            <span className="field__label">Last tool</span>
            <span className="field__value">
              <code>{agent.lastToolName}</code> {agent.lastToolSummary ?? ''}
            </span>
          </div>
        ) : null}
      </div>

      {agent.promptPreview ? (
        <details className="block">
          <summary>prompt</summary>
          <p className="block__body">{agent.promptPreview}</p>
        </details>
      ) : null}
      {agent.resultPreview ? (
        <details className="block" open={!result.structured}>
          <summary>
            {result.structured ? 'raw json' : 'result'}
            {result.partial ? ' · truncated by the run' : ''}
          </summary>
          <p className="block__body">{agent.resultPreview}</p>
        </details>
      ) : null}
      <details className="block">
        <summary>{agent.toolCalls} tool calls</summary>
        <p className="block__body">
          {agent.lastToolName
            ? `Only the last call is recorded for a workflow agent: ${agent.lastToolName}${
                agent.lastToolSummary ? ` — ${agent.lastToolSummary}` : ''
              }`
            : 'This run recorded no tool detail for the agent.'}
        </p>
      </details>

      {siblings.length > 1 ? (
        <div className="siblings">
          <div className="siblings__head">
            same task · {siblings.length} agents
            <span className="siblings__nav">
              <button className="siblings__btn" onClick={() => step(-1)} disabled={at <= 0}>
                ↑
              </button>
              <button
                className="siblings__btn"
                onClick={() => step(1)}
                disabled={at >= siblings.length - 1}
              >
                ↓
              </button>
            </span>
          </div>
          <div className="compare">
            {siblings.map((other) => {
              const otherVerdict = verdictOf(other)
              const note = readResult(other.resultPreview).confidence
              return (
                <button
                  key={other.index}
                  className={`cmp ${other.index === agent.index ? 'cmp--on' : ''}`}
                  onClick={() => onView({ ...view, agentIndex: other.index })}
                >
                  <span className="cmp__id">
                    {instanceOf(other.label) || other.label}{' '}
                    {other.model?.replace(/^claude-/, '').replace(/-\d{8}$/, '') ?? ''}
                  </span>
                  <span
                    className={`pill ${
                      otherVerdict.tone === 'good'
                        ? 'pill--good'
                        : otherVerdict.tone === 'bad'
                          ? 'pill--bad'
                          : ''
                    }`}
                  >
                    {otherVerdict.text}
                  </span>
                  <span className="cmp__note">
                    {note ? `${note} · ` : ''}
                    {duration(other.durationMs)}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** Breadcrumb trail for the workflows tab. */
export function WorkflowCrumbs({
  workflows,
  view,
  onView,
}: {
  workflows: WorkflowRun[]
  view: WfView
  onView: (view: WfView) => void
}): React.JSX.Element | null {
  if (view.level === 'runs') return null
  const run = workflows.find((w) => w.runId === view.runId)
  if (!run) return null

  const many = workflows.length > 1
  const back = (): void => {
    if (view.level === 'agent') onView({ level: 'phase', runId: view.runId, phaseIndex: view.phaseIndex })
    else if (view.level === 'phase') onView({ level: 'run', runId: view.runId })
    else if (many) onView({ level: 'runs' })
  }

  const phaseTitle =
    'phaseIndex' in view ? `${view.phaseIndex}. ${run.phases[view.phaseIndex - 1]?.title ?? ''}` : ''

  return (
    <div className="crumbs">
      <button
        className="crumbs__back"
        onClick={back}
        disabled={view.level === 'run' && !many}
        aria-label="Back one level"
      >
        ‹
      </button>
      <div className="crumbs__path">
        {view.level === 'run' ? (
          <span className="crumbs__now">{run.name}</span>
        ) : (
          <>
            <button className="crumbs__link" onClick={() => onView({ level: 'run', runId: run.runId })}>
              {run.name}
            </button>
            <span className="crumbs__sep">/</span>
            {/*
              An open agent stops at the phase, because the agent is the list selection
              beside it rather than a level of its own — a third segment here would name
              something the reader is already pointing at.
            */}
            <span className="crumbs__now">{phaseTitle}</span>
          </>
        )}
      </div>
    </div>
  )
}
