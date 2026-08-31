import { Fragment, useEffect, useMemo, useState } from 'react'
import type { ActivitySummary, AgentToolCall, Subagent } from '../../shared/types.ts'
import { age, model as shortModel, tokens as formatTokens } from '../format.ts'
import { useDockedSelection } from '../useDockedSelection.ts'
import { toolDiffs } from '../diff.ts'
import { DiffView } from './DiffView.tsx'

/**
 * Where the agents view is pointing.
 *
 * Loose subagents are few and usually in flight, so this tab stays a flat list — no
 * phases and no roll-up, unlike a workflow run. There are only two levels: the list, and
 * one agent.
 */
export type SubView = { level: 'list' } | { level: 'agent'; agentId: string }

/** Format a millisecond span as `4m 12s`, `3m`, or `48s`. */
function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest > 0 ? `${minutes}m ${String(rest).padStart(2, '0')}s` : `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** How long an agent has been going, or how long it took. */
function elapsed(agent: Subagent): string {
  return duration(new Date(agent.lastActivityAt).getTime() - new Date(agent.startedAt).getTime())
}

function dotFor(status: Subagent['status']): string {
  if (status === 'running') return 'dot--working'
  if (status === 'failed') return 'dot--failed'
  return 'dot--ended'
}

function nameOf(agent: Subagent): string {
  return agent.description ?? agent.prompt.slice(0, 60) ?? agent.agentId.slice(0, 10)
}

function Stats({ agent, detailed }: { agent: Subagent; detailed?: boolean }): React.JSX.Element {
  return (
    <div className="stats">
      {detailed && agent.agentType ? (
        <span className="stat">
          type <b>{agent.agentType}</b>
        </span>
      ) : null}
      {detailed && agent.model ? (
        <span className="stat">
          model <b>{shortModel(agent.model)}</b>
        </span>
      ) : null}
      {detailed ? (
        <span className="stat">
          {agent.status === 'running' ? 'up' : 'ran'} <b>{elapsed(agent)}</b>
        </span>
      ) : null}
      <span className="stat">
        turns <b>{agent.assistantTurns}</b>
      </span>
      <span className="stat">
        tools <b>{agent.toolCalls}</b>
      </span>
      <span className="stat">
        tokens <b>{formatTokens(agent.tokens || agent.outputTokens)}</b>
      </span>
    </div>
  )
}

/** The current tool call, or the finished agent's closing line. */
function LiveLine({ agent }: { agent: Subagent }): React.JSX.Element | null {
  if (agent.status === 'running' && agent.lastActivity) {
    return (
      <p className="live">
        <span className="live__who">{agent.lastActivity.tool}</span>
        <span className="live__what">{agent.lastActivity.detail}</span>
        <span className="live__age">{age(agent.lastActivity.at)}</span>
      </p>
    )
  }
  if (!agent.notes && !agent.lastActivity) return null
  return (
    <p className="live live--idle">
      <span className="live__who">{agent.notes ? 'result' : agent.lastActivity?.tool}</span>
      <span className="live__what">
        {agent.notes ? agent.notes.replace(/\s+/g, ' ') : (agent.lastActivity?.detail ?? '')}
      </span>
      <span className="live__age">ran {elapsed(agent)}</span>
    </p>
  )
}

/** The agents tab: a flat list of subagents, or one of them in detail. */
export function SubagentRail({
  subagents,
  view,
  onView,
  onReveal,
  sessionId,
  cwd,
}: {
  subagents: Subagent[]
  view: SubView
  onView: (view: SubView) => void
  /** Open the `Agent` call that launched an agent, back in the conversation. */
  onReveal: (callId: string) => void
  sessionId: string
  cwd: string
}): React.JSX.Element {
  // Opening an agent moves the conversation to the call that launched it, so the rail and
  // the transcript stay pointed at the same thing.
  const open = (agent: Subagent): void => {
    onView({ level: 'agent', agentId: agent.agentId })
    if (agent.callId) onReveal(agent.callId)
  }
  const running = subagents.filter((a) => a.status === 'running')
  const failed = subagents.filter((a) => a.status === 'failed')
  const finished = subagents.filter((a) => a.status === 'done')

  if (view.level === 'agent') {
    return (
      <AgentDock
        groups={[
          ['running', running],
          ['failed', failed],
          ['finished', finished],
        ]}
        agentId={view.agentId}
        onOpen={open}
        sessionId={sessionId}
        cwd={cwd}
      />
    )
  }

  const group = (label: string, list: Subagent[]): React.JSX.Element | null =>
    list.length === 0 ? null : (
      <>
        <p className="grouphead">{label}</p>
        {list.map((agent) => (
          <article
            key={agent.agentId}
            className={`sub sub--${agent.status}`}
            role="button"
            tabIndex={0}
            onClick={() => open(agent)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                open(agent)
              }
            }}
          >
            <header className="sub__head">
              <span className={`dot ${dotFor(agent.status)}`} />
              <span className="sub__name">{nameOf(agent)}</span>
              {agent.agentType ? <span className="sub__type">{agent.agentType}</span> : null}
              <span className="sub__age">{age(agent.lastActivityAt)}</span>
            </header>
            <LiveLine agent={agent} />
            <Stats agent={agent} />
          </article>
        ))}
      </>
    )

  return (
    <div className="rail__section">
      {group('running', running)}
      {group('failed', failed)}
      {group('finished', finished)}
    </div>
  )
}

/**
 * The session's agents beside the one being read.
 *
 * A session runs a handful of agents at once and they are all doing different things, so
 * the interesting question is usually how one compares with its neighbours. Keeping the
 * list docked answers that in a click instead of a round trip through the back arrow.
 */
function AgentDock({
  groups,
  agentId,
  onOpen,
  sessionId,
  cwd,
}: {
  groups: [string, Subagent[]][]
  agentId: string
  onOpen: (agent: Subagent) => void
  sessionId: string
  cwd: string
}): React.JSX.Element {
  const agent = groups.flatMap(([, list]) => list).find((a) => a.agentId === agentId)
  const selected = useDockedSelection(agentId)

  return (
    <div className="split">
      <nav className="split__list" aria-label="Subagents">
        {groups.map(([label, list]) =>
          list.length === 0 ? null : (
            <Fragment key={label}>
              <p className="split__group">
                {label} · {list.length}
              </p>
              {list.map((entry) => (
                <button
                  key={entry.agentId}
                  ref={entry.agentId === agentId ? selected : undefined}
                  className={`li ${entry.agentId === agentId ? 'li--on' : ''}`}
                  onClick={() => onOpen(entry)}
                  title={nameOf(entry)}
                >
                  <span className={`dot ${dotFor(entry.status)}`} />
                  <span className="li__name">{nameOf(entry)}</span>
                </button>
              ))}
            </Fragment>
          ),
        )}
      </nav>
      <div className="split__detail">
        {agent ? (
          <AgentDetail agent={agent} sessionId={sessionId} cwd={cwd} />
        ) : (
          <p className="rail__note">That agent is no longer in the session.</p>
        )}
      </div>
    </div>
  )
}

/** One subagent: its objective, its tool calls, and whatever it has said so far. */
function AgentDetail({
  agent,
  sessionId,
  cwd,
}: {
  agent: Subagent
  sessionId: string
  cwd: string
}): React.JSX.Element {
  const calls = useAgentTools(sessionId, agent)

  return (
    <div className="detail">
      <div className="detail__head">
        <span className={`dot ${dotFor(agent.status)}`} />
        <span className="detail__name">{nameOf(agent)}</span>
        <span className="detail__state">{agent.status}</span>
      </div>

      <Stats agent={agent} detailed />
      {/*
        Only while it is running: a finished agent's closing line is its result, cut to one
        line, and the result itself is already here in full at the bottom.
      */}
      {agent.status === 'running' ? <LiveLine agent={agent} /> : null}

      {agent.prompt ? (
        <div className="field field--wide">
          <span className="field__label">Objective</span>
          <span className="field__value">{agent.prompt}</span>
        </div>
      ) : null}

      <ToolStream calls={calls} summaries={agent.recentTools.slice(-14)} cwd={cwd} />

      {agent.notes ? (
        <details className="block" open>
          <summary>{agent.status === 'running' ? 'notes so far' : 'result'}</summary>
          <p className="block__body">{agent.notes}</p>
        </details>
      ) : null}
    </div>
  )
}

/**
 * Read one agent's tool calls, with their inputs and results.
 *
 * An agent's calls are in its own transcript, not the parent's, so they cost a request of
 * their own — asked for when a detail is opened rather than shipped with the agent list,
 * where sixty agents' worth of command output would be megabytes nobody looked at.
 */
function useAgentTools(sessionId: string, agent: Subagent): AgentToolCall[] | null {
  const [calls, setCalls] = useState<AgentToolCall[] | null>(null)
  const { agentId, lastActivityAt } = agent

  useEffect(() => {
    let stopped = false
    setCalls(null)
    void (async () => {
      try {
        const response = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(agentId)}/tools`,
        )
        if (!response.ok) throw new Error(`server returned ${response.status}`)
        const body = (await response.json()) as { tools: AgentToolCall[] }
        if (!stopped) setCalls(body.tools)
      } catch {
        // The summaries the agent list already carries stay on screen instead.
      }
    })()
    return () => {
      stopped = true
    }
    // A running agent keeps making calls, so its stream is re-read as the agent advances.
  }, [sessionId, agentId, lastActivityAt])

  return calls
}

/**
 * The agent's tool calls, oldest first so the freshest sits nearest the composer.
 *
 * Reading the agent's own transcript takes a request, so the one-line summaries the agent
 * list already carries hold the space until it lands. They say the same thing; they just do
 * not open.
 */
function ToolStream({
  calls,
  summaries,
  cwd,
}: {
  calls: AgentToolCall[] | null
  summaries: ActivitySummary[]
  cwd: string
}): React.JSX.Element | null {
  if (calls !== null) {
    if (calls.length === 0) return null
    return (
      <div className="toolstream">
        {calls.map((call) => (
          <AgentCall key={call.id} call={call} cwd={cwd} />
        ))}
      </div>
    )
  }

  if (summaries.length === 0) return null
  return (
    <div className="toolstream">
      {summaries.map((call, index) => (
        <div key={`${call.at}-${index}`} className="toolstream__row">
          <span className="toolstream__mark" />
          <span className="toolstream__name">{call.tool}</span>
          <span className="toolstream__arg" title={call.detail}>
            {call.detail}
          </span>
          <span className="toolstream__t">{age(call.at)} ago</span>
        </div>
      ))}
    </div>
  )
}

/**
 * One of the agent's tool calls, opening onto what it ran and what came back.
 *
 * The same shape a tool call has in the conversation, because it is the same thing — an
 * edit reads as a diff, anything else as its input and its output.
 */
function AgentCall({ call, cwd }: { call: AgentToolCall; cwd: string }): React.JSX.Element {
  const diffs = useMemo(() => toolDiffs(call.tool, call.input), [call])
  const detail = call.detail.startsWith(cwd) ? call.detail.slice(cwd.length + 1) : call.detail

  return (
    <details className={`agentcall ${call.isError ? 'agentcall--error' : ''}`}>
      <summary className="toolstream__row">
        {/* The caret is drawn by the stylesheet, which is what knows whether it is open. */}
        <span className="toolstream__mark" />
        <span className="toolstream__name">{call.tool}</span>
        <span className="toolstream__arg" title={call.detail}>
          {detail || call.tool}
        </span>
        <span className="toolstream__t">{call.at ? `${age(call.at)} ago` : ''}</span>
      </summary>
      <div className="tool-entry__body">
        {diffs ? (
          <DiffView diffs={diffs} cwd={cwd} />
        ) : (
          <pre className="tool-entry__input">{JSON.stringify(call.input, null, 2)}</pre>
        )}
        {call.result === null ? (
          <p className="tool-entry__pending">the agent stopped before this answered</p>
        ) : (
          <pre className="tool-entry__result">
            {call.result}
            {call.resultTruncated ? '\n\n… result truncated' : ''}
          </pre>
        )}
      </div>
    </details>
  )
}

/** Breadcrumb trail for the agents tab. */
export function SubagentCrumbs({
  subagents,
  view,
  onView,
}: {
  subagents: Subagent[]
  view: SubView
  onView: (view: SubView) => void
}): React.JSX.Element {
  const running = subagents.filter((a) => a.status === 'running').length

  // The open agent is the docked list's selection rather than a level of its own, so the
  // trail says the same thing either way and only the back arrow changes.
  return (
    <div className="crumbs">
      <button
        className="crumbs__back"
        onClick={() => onView({ level: 'list' })}
        disabled={view.level === 'list'}
        aria-label="Back to the agent list"
      >
        ‹
      </button>
      <div className="crumbs__path">
        <span className="crumbs__now">
          {subagents.length} {subagents.length === 1 ? 'subagent' : 'subagents'}
          {running > 0 ? ` · ${running} running` : ''}
        </span>
      </div>
    </div>
  )
}
