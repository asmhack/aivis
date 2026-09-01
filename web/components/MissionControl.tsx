import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AttentionItem, Session, SessionStatus } from '../../shared/types.ts'
import {
  age,
  contextNote,
  homePath,
  model as modelName,
  spanWords,
  tokens as fmtTokens,
} from '../format.ts'
import { RunningTasks } from './RunningTasks.tsx'
import { useDismissed } from '../useAttention.ts'
import type { Notifier } from '../useNotify.ts'
import { useBlockUsage } from '../useBlockUsage.ts'
import { useDefaults } from '../useDefaults.ts'
import type { Defaults } from '../../shared/types.ts'
import { BlockMeter } from './BlockMeter.tsx'
import type { ConnectionState } from '../useFleet.ts'

/**
 * The index: what needs you, what is moving, and everything else.
 *
 * The page is ordered by how much of your attention a thing has earned rather than by
 * recency. A queue of sessions that have stopped and are holding for you comes first,
 * because that is the only part of the fleet that is losing time while you read. The
 * sessions still advancing come next as tiles, since they need watching but not acting
 * on. Everything else — every project you have ever run a session in — collapses into
 * one list at the bottom, which is where you go looking rather than where you are told.
 */

/** Order the fleet list puts sessions in, most alive first. */
const STATUS_ORDER: SessionStatus[] = ['working', 'stalled', 'idle', 'parked', 'ended']

/** How many projects the fleet list shows before it asks whether you want the rest. */
const PROJECTS_SHOWN = 8

/** How many open sessions are listed before the rest are folded away. */
const OPEN_SHOWN = 8

/** Remembers whether you left the legend open, so it stays how you put it. */
const LEGEND_KEY = 'aivis.legend'

/**
 * What the socket's state is called on screen.
 *
 * The state names are the socket's own — they mirror `WebSocket.OPEN` and `CLOSED` — but
 * on a page whose every other word is about sessions, a badge reading `open` was taken to
 * mean an open session rather than an open connection. These say the thing the badge is
 * actually there to report: whether the numbers beside it are still arriving.
 */
const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: 'connecting',
  open: 'live',
  closed: 'offline',
}

const CONNECTION_HINT: Record<ConnectionState, string> = {
  connecting: 'Opening the connection to aivis. The counts are from the last update until it does.',
  open: 'Connected to aivis. Everything on this page updates as it happens, rather than being polled.',
  closed:
    'The connection to aivis dropped, so nothing here is updating — these counts are frozen at whatever arrived last. Reconnecting automatically.',
}

/**
 * What every word on this page means, written once and used everywhere it appears.
 *
 * The five states are not self-evident — `parked` in particular is aivis's own invention,
 * and `idle` sounds like a criticism when it only means a terminal is open — so each is
 * explained on hover and, for anyone who does not think to hover, in the legend below the
 * header. The two thresholds are read from the server rather than written into the prose,
 * because both are settings and a sentence quoting the wrong number is worse than one
 * quoting none.
 */
function glossary(defaults: Defaults | null): { key: string; dot: string; term: string; body: string }[] {
  const stale = defaults ? spanWords(defaults.staleAfterMs) : 'a couple of minutes'
  const window = defaults ? spanWords(defaults.waitingWindowMs) : 'a few hours'
  const ttl = defaults ? `${defaults.parkTtlDays} days` : 'a fortnight'
  return [
    {
      key: 'working',
      dot: 'working',
      term: 'working',
      body: 'A claude process is alive and its transcript is advancing right now. This is the only state where tokens are being spent.',
    },
    {
      key: 'background',
      dot: 'working',
      term: 'background',
      body: 'The session handed work off to run outside its own turn — a workflow, a subagent, a backgrounded command — and finished the turn without waiting for it. Its own status is whatever its thread is doing, which is usually idle, so these are counted under that as well. Nothing is waiting on you: Claude Code picks the conversation back up itself when the work reports in, which is why these are shown as advancing rather than queued.',
    },
    {
      key: 'idle',
      dot: 'idle',
      term: 'idle',
      body: `A process is alive but its turn has finished: a terminal you left open. It costs nothing, holds its whole context, and carries on the moment you write to it. Unless it left work running behind the turn — see background.`,
    },
    {
      key: 'asking',
      dot: 'asking',
      term: 'asking you',
      body: 'The session stopped mid-turn for something only you can give it: a multiple-choice question it asked, or a tool Claude Code will not run unasked. This is the only queue here that a session asked to be in rather than being inferred from silence, and the only one where something is genuinely blocked — nothing else will be written until it is answered. A session aivis drives can be answered from its own page; one running in a terminal has to be answered there, and the row says which.',
    },
    {
      key: 'waiting',
      dot: 'idle',
      term: 'waiting on you',
      body: `An idle session that stopped within the last ${window}, so it is probably holding for your reply rather than simply left open. These are counted under idle as well — the queue is a view of the fleet, not a place a session moves to.`,
    },
    {
      key: 'stalled',
      dot: 'stalled',
      term: 'stalled',
      body: `Alive and mid-turn, but nothing has been written for over ${stale} and it has not said why. Usually a long-running command, or a session in a terminal holding at a prompt only that terminal can answer. A session that stopped to ask you something is counted under asking you instead, because it said so.`,
    },
    {
      key: 'parked',
      dot: 'parked',
      term: 'parked',
      body: `No process is running, but aivis saw this session alive before — usually the machine was shut down. Sending to it resumes it exactly where it stopped. Kept for ${ttl} after it was last seen running.`,
    },
    {
      key: 'ended',
      dot: 'ended',
      term: 'ended',
      body: 'No process and no record of one: an ordinary finished transcript. Still on disk, and still resumable by copying its resume command into a terminal.',
    },
  ]
}

/** Look one term up, for the tooltips that say the same thing the legend does. */
function hintFor(defaults: Defaults | null, key: string): string {
  return glossary(defaults).find((entry) => entry.key === key)?.body ?? ''
}

/**
 * Whether a session has work running outside its own turn.
 *
 * A server older than this build sends no `background` at all, so it is read defensively:
 * the whole page would otherwise fall to the error boundary over a field that simply is
 * not there yet.
 */
function handedOff(session: Session): boolean {
  return (session.background ?? []).length > 0
}

interface Project {
  cwd: string
  name: string
  sessions: Session[]
  lastActivityAt: string
}

export function MissionControl({
  sessions,
  connection,
  attention: items,
  reloadAttention: reload,
  notifier,
  onOpen,
  onNew,
}: {
  sessions: Session[]
  connection: ConnectionState
  /** The whole attention queue, fetched by the app so notifications outlive this page. */
  attention: AttentionItem[]
  /** Re-read it, for when acting on a row has just changed the answer. */
  reloadAttention: () => void
  notifier: Notifier
  onOpen: (id: string) => void
  onNew: (cwd: string | null) => void
}): React.JSX.Element {
  const { dismissed, dismiss, restore } = useDismissed()
  const usage = useBlockUsage()
  const defaults = useDefaults()
  const [legend, setLegend] = useState(() => {
    try {
      return localStorage.getItem(LEGEND_KEY) === 'open'
    } catch {
      return false
    }
  })
  const [query, setQuery] = useState('')
  const [openProjects, setOpenProjects] = useState<Set<string>>(new Set())
  const [openEnded, setOpenEnded] = useState<Set<string>>(new Set())
  const [allProjects, setAllProjects] = useState(false)
  const [allOpen, setAllOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const { toast, say } = useToast()

  const needle = query.trim().toLowerCase()
  const hits = useCallback(
    (session: Session): boolean =>
      !needle ||
      session.title.toLowerCase().includes(needle) ||
      session.cwd.toLowerCase().includes(needle) ||
      session.projectName.toLowerCase().includes(needle) ||
      (session.lastActivity?.detail.toLowerCase().includes(needle) ?? false),
    [needle],
  )

  const matched = useMemo(() => sessions.filter(hits), [sessions, hits])

  // The queue you have not waved away, before the search box narrows it: the header
  // counts the fleet as it is, so filtering the page must not appear to change it.
  const standing = useMemo(() => items.filter((item) => !dismissed.has(item.id)), [items, dismissed])

  const queue = useMemo(
    () =>
      standing.filter(
        (item) =>
          !needle ||
          item.title.toLowerCase().includes(needle) ||
          item.projectName.toLowerCase().includes(needle),
      ),
    [standing, needle],
  )

  /**
   * Everything advancing, which is not the same as everything working.
   *
   * A session that hands off a workflow is finished with the turn that started it, so its
   * own status goes to `idle` while the work it launched spends more than anything else on
   * the machine. Reading the section as "sessions whose own transcript is moving" put that
   * session under the sessions you have left open and told you nothing was advancing, which
   * was the one moment this section exists for.
   */
  const running = useMemo(
    () =>
      matched
        .filter((session) => session.status === 'working' || handedOff(session))
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
    [matched],
  )

  /**
   * Live sessions that have finished their turn — the terminals you have open.
   *
   * These used to appear nowhere above the project list, which made a machine running
   * fifteen of them look idle in the literal sense. They are listed rather than tiled
   * because none of them is doing anything worth watching; what you want from this
   * section is to find one, not to monitor it.
   *
   * One that handed work off is doing something worth watching, so it is tiled above
   * instead. Running and open are the same claim in two registers — advancing, or not —
   * and a session cannot honestly be in both.
   */
  const openSessions = useMemo(
    () =>
      matched
        .filter((session) => session.status === 'idle' && !handedOff(session))
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
    [matched],
  )

  /**
   * Every project, carrying every session in it.
   *
   * The queue and the tiles above are a view of what is urgent, not a place a session
   * moves to, so a session that appears there appears here as well. That repetition is
   * deliberate: this list is the index you go looking in, and one that hides whatever is
   * currently urgent cannot answer "where did that session go" — the honest answer has to
   * be that it is in its project, the same as every other session.
   */
  const projects = useMemo(() => {
    const byCwd = new Map<string, Project>()
    for (const session of matched) {
      const project = byCwd.get(session.cwd) ?? {
        cwd: session.cwd,
        name: session.projectName,
        sessions: [],
        lastActivityAt: session.lastActivityAt,
      }
      project.sessions.push(session)
      if (session.lastActivityAt > project.lastActivityAt) project.lastActivityAt = session.lastActivityAt
      byCwd.set(session.cwd, project)
    }
    for (const project of byCwd.values()) {
      project.sessions.sort(
        (a, b) =>
          STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
          b.lastActivityAt.localeCompare(a.lastActivityAt),
      )
    }
    return [...byCwd.values()].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  }, [matched])

  const kinds = {
    asking: standing.filter((i) => i.kind === 'asking').length,
    waiting: standing.filter((i) => i.kind === 'waiting').length,
    stalled: standing.filter((i) => i.kind === 'stalled').length,
  }
  const workingCount = sessions.filter((s) => s.status === 'working').length
  // Sessions advancing behind a finished turn. Counted separately from working because it
  // is a different thread doing it, and counted at all because the header reading zero
  // working while a workflow spends everything on the machine is the fleet's blind spot.
  const backgroundCount = sessions.filter(handedOff).length
  // Every session whose turn has ended but whose process is still alive. Most of these
  // are terminals left open rather than anything to act on, which is exactly why the
  // header has to say so: without this count a machine running fifteen sessions reads
  // as a machine running none.
  const idleCount = sessions.filter((s) => s.status === 'idle').length
  const parkedCount = sessions.filter((s) => s.status === 'parked').length
  const liveCount = sessions.filter((s) => s.livePids.length > 0).length
  const hiddenCount = items.length - standing.length

  const showLegend = (next: boolean): void => {
    setLegend(next)
    try {
      localStorage.setItem(LEGEND_KEY, next ? 'open' : 'shut')
    } catch {
      // Storage that refuses to write just means the choice lasts this session only.
    }
  }

  /** Send a session a message from the index, without opening it. */
  const nudge = async (item: AttentionItem): Promise<void> => {
    setBusy(item.id)
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(item.sessionId)}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'continue' }),
      })
      const body = (await response.json()) as { error?: string; delivered?: boolean }
      if (!response.ok) say(body.error ?? 'the session would not take the message')
      else say(`nudged ${item.projectName} — sent “continue”`)
      reload()
    } catch (err) {
      say(String(err))
    } finally {
      setBusy(null)
    }
  }

  const copyResume = async (session: Session): Promise<void> => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/handoff`)
    const body = (await response.json()) as { command?: string }
    if (!body.command) return say('no resume command for that session')
    await navigator.clipboard.writeText(body.command)
    say('resume command copied')
  }

  const toggle = (set: Set<string>, key: string, apply: (next: Set<string>) => void): void => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    apply(next)
  }

  const visibleProjects = allProjects ? projects : projects.slice(0, PROJECTS_SHOWN)
  const visibleOpen = allOpen ? openSessions : openSessions.slice(0, OPEN_SHOWN)

  return (
    <div className="mission">
      <header className="vitals">
        <span className="vitals__mark">
          ai<b>vis</b>
        </span>
        <span className={`conn conn--${connection}`} title={CONNECTION_HINT[connection]}>
          {CONNECTION_LABEL[connection]}
        </span>
        <Vital n={workingCount} label="working" tone="working" hint={hintFor(defaults, 'working')} />
        <Vital
          n={backgroundCount}
          label="background"
          tone="working"
          hint={hintFor(defaults, 'background')}
        />
        <Vital n={idleCount} label="idle" tone="idle" hint={hintFor(defaults, 'idle')} />
        <Vital n={kinds.asking} label="asking you" tone="asking" hint={hintFor(defaults, 'asking')} />
        <Vital n={kinds.waiting} label="waiting on you" tone="waiting" hint={hintFor(defaults, 'waiting')} />
        <Vital n={kinds.stalled} label="stalled" tone="stalled" hint={hintFor(defaults, 'stalled')} />
        <Vital n={parkedCount} label="parked" tone="parked" hint={hintFor(defaults, 'parked')} />
        <button
          className={`legendtoggle ${legend ? 'legendtoggle--on' : ''}`}
          onClick={() => showLegend(!legend)}
          title="What working, idle, asking, stalled and parked each mean"
          aria-expanded={legend}
        >
          ?
        </button>
        <span className="vitals__sp" />
        <input
          className="search search--slim"
          placeholder="filter by prompt, path, or activity"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {usage ? (
          <span className="rate" title="Tokens recorded since midnight, main threads and subagents together, cache reads included.">
            <span className="rate__n">{fmtTokens(usage.todayTokens)}</span>
            <span className="rate__l">today</span>
          </span>
        ) : null}
        <BlockMeter />
        <button className="newsess" onClick={() => onNew(null)}>
          New session<span className="newsess__key">⌘N</span>
        </button>
      </header>

      <main className="fleet">
        {legend ? <Legend defaults={defaults} live={liveCount} /> : null}

        {sessions.length === 0 ? (
          <p className="empty">
            No sessions indexed yet. Check that the server can read ~/.claude/projects.
          </p>
        ) : null}

        <section className="sect">
          <h2 className="sect__head">
            <span className="sect__title">Needs you</span>
            <span className="sect__note">
              {queue.length > 0 ? 'longest wait first' : needle ? 'no match' : 'all clear'}
            </span>
            {hiddenCount > 0 ? (
              <button className="linkish" onClick={restore}>
                {hiddenCount} dismissed — bring back
              </button>
            ) : null}
            <NotifyToggle notifier={notifier} onSay={say} />
            <span className="sect__rule" />
          </h2>
          {queue.length === 0 ? (
            <div className="qempty">
              {needle
                ? `nothing in the queue matches “${query.trim()}”`
                : '✓ nothing needs you — the fleet is on its own'}
            </div>
          ) : (
            <div className="queue">
              {queue.map((item) => (
                <QueueRow
                  key={item.id}
                  item={item}
                  busy={busy === item.id}
                  onOpen={() => {
                    // Opening a session you were holding up is the answer to it, so the
                    // row goes away. A stalled session is still stalled after you look at
                    // it, so that one stays.
                    if (item.kind === 'waiting') dismiss(item.id)
                    onOpen(item.sessionId)
                  }}
                  onNudge={() => void nudge(item)}
                  onDismiss={() => dismiss(item.id)}
                />
              ))}
            </div>
          )}
        </section>

        <section className="sect">
          <h2 className="sect__head">
            <span className="sect__title">Running</span>
            <span className="sect__note">
              {running.length} {running.length === 1 ? 'session' : 'sessions'} · live
            </span>
            <span className="sect__rule" />
          </h2>
          {running.length === 0 ? (
            <div className="qempty">
              {needle ? `nothing advancing matches “${query.trim()}”` : 'nothing is advancing right now'}
            </div>
          ) : (
            <div className="tiles">
              {running.map((session) => (
                <Tile key={session.id} session={session} onOpen={() => onOpen(session.id)} />
              ))}
            </div>
          )}
        </section>

        {openSessions.length > 0 ? (
          <section className="sect">
            <h2 className="sect__head">
              <span className="sect__title">Open</span>
              <span className="sect__note" title={hintFor(defaults, 'idle')}>
                {openSessions.length} {openSessions.length === 1 ? 'session' : 'sessions'} · alive, turn
                finished
              </span>
              <span className="sect__rule" />
            </h2>
            <div className="slist slist--flat">
              {visibleOpen.map((session) => (
                <SessionLine
                  key={session.id}
                  session={session}
                  where
                  onOpen={() => onOpen(session.id)}
                  onResume={() => void copyResume(session)}
                />
              ))}
            </div>
            {openSessions.length > OPEN_SHOWN ? (
              <button className="more more--flat" onClick={() => setAllOpen(!allOpen)}>
                {allOpen ? '▾ fewer' : `▸ ${openSessions.length - OPEN_SHOWN} more open`}
              </button>
            ) : null}
          </section>
        ) : null}

        {projects.length > 0 ? (
          <section className="sect">
            <h2 className="sect__head">
              <span className="sect__title">Rest of the fleet</span>
              <span className="sect__note">
                {projects.length} {projects.length === 1 ? 'project' : 'projects'} · every session, urgent or not
              </span>
              <span className="sect__rule" />
            </h2>
            <div className="rest">
              {visibleProjects.map((project) => (
                <ProjectRow
                  key={project.cwd}
                  project={project}
                  defaults={defaults}
                  open={openProjects.has(project.cwd)}
                  endedOpen={openEnded.has(project.cwd)}
                  onToggle={() => toggle(openProjects, project.cwd, setOpenProjects)}
                  onToggleEnded={() => toggle(openEnded, project.cwd, setOpenEnded)}
                  onOpen={onOpen}
                  onNew={() => onNew(project.cwd)}
                  onResume={copyResume}
                />
              ))}
            </div>
            {projects.length > PROJECTS_SHOWN ? (
              <button className="more more--flat" onClick={() => setAllProjects(!allProjects)}>
                {allProjects ? '▾' : '▸'} {allProjects ? 'fewer projects' : `${projects.length - PROJECTS_SHOWN} more projects`}
              </button>
            ) : null}
          </section>
        ) : null}
      </main>

      <div className={`toast ${toast ? 'is-on' : ''}`}>{toast}</div>
    </div>
  )
}

/**
 * One headline count in the vitals bar.
 *
 * The hint is the same sentence the legend prints, so hovering a count and opening the
 * legend can never tell you two different things about the same word.
 */
function Vital({
  n,
  label,
  tone,
  hint,
}: {
  n: number
  label: string
  tone: string
  hint: string
}): React.JSX.Element {
  return (
    <span className={`vit ${n === 0 ? 'vit--zero' : ''}`} title={hint}>
      <span className={`vit__n vit__n--${tone}`}>{n}</span>
      <span className="vit__l">{label}</span>
    </span>
  )
}

/** The whole vocabulary, spelled out under the header for anyone who does not hover. */
function Legend({ defaults, live }: { defaults: Defaults | null; live: number }): React.JSX.Element {
  return (
    <div className="legend">
      <p className="legend__lede">
        Every session is in exactly one of five states, decided by whether a{' '}
        <code>claude</code> process is alive and by what its transcript last recorded.{' '}
        <b>background</b>, <b>asking you</b> and <b>waiting on you</b> are not states but
        readings drawn from those sessions — the first of what a session left running behind
        its turn, the other two of what has stopped for you. Right now{' '}
        {live === 1 ? 'one session has' : `${live} sessions have`} a live process on this
        machine.
      </p>
      <dl className="legend__list">
        {glossary(defaults).map((entry) => (
          <div key={entry.key} className="legend__row">
            <dt className="legend__term">
              <span className={`dot dot--${entry.dot}`} />
              {entry.term}
            </dt>
            <dd className="legend__body">{entry.body}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** A short-lived line of feedback for an action taken from the index. */
function useToast(): { toast: string | null; say: (message: string) => void } {
  const [toast, setToast] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const say = useCallback((message: string): void => {
    setToast(message)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setToast(null), 2600)
  }, [])
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  return { toast, say }
}

/**
 * How one queue item reads, which is entirely a matter of why it is there.
 *
 * The three kinds ask for very different things and only two of them are a problem, so
 * each carries a hint that says which: a session with a question wants answering and is
 * the only one truly blocked, a stalled session is stuck and may want nudging, and an idle
 * session wants nothing at all beyond your next prompt. Calling that last one "waiting on
 * you" made it read as blocked, which sent you into a session to look for a question that
 * was never there — the question this queue can now point at.
 */
function copyFor(item: AttentionItem): {
  why: string
  hint: string
  tone: string
  dot: string
  title: string
} {
  if (item.kind === 'asking') {
    const permission = item.askKind === 'permission'
    const where = item.answerable
      ? 'Open it and answer above the composer.'
      : 'This session runs in a terminal, so the answer has to be given there.'
    return {
      why: permission ? 'needs a decision' : 'asking you',
      hint: permission
        ? `The session called a tool Claude Code will not run unasked, and stopped for your answer. It writes nothing at all until it gets one. ${where}`
        : `The session asked you a multiple-choice question and stopped mid-turn for the answer. ${where}`,
      tone: 'ask',
      dot: 'asking',
      // What was asked, not the session's opening prompt: it is the one thing on this row
      // that says what is actually wanted, and the row exists to get it answered.
      title: item.ask?.question ?? item.title,
    }
  }
  if (item.kind === 'stalled') {
    return {
      why: 'stalled',
      hint: 'The process is alive but the transcript has not advanced and it has not said why. Usually a long-running command, or a session in a terminal holding at a prompt only that terminal can answer.',
      tone: 'stall',
      dot: 'stalled',
      title: item.title,
    }
  }
  return {
    why: 'your turn',
    hint: 'Claude finished its turn and the session is sitting at the prompt. Nothing is blocked and there is nothing to answer — it is just idle until you ask for something else. Opening it clears this row.',
    tone: 'wait',
    dot: 'idle',
    title: item.title,
  }
}

/**
 * The switch for system notifications, kept beside the queue it speaks for.
 *
 * It sits here rather than in the header because this is the section it is about: the rows
 * below are exactly what it will tell you about, and putting the switch anywhere else
 * would leave you guessing which of the page's several kinds of news it covers. The label
 * says what state it is in rather than what clicking does, on the grounds that whether
 * banners are coming is the thing you want to know at a glance.
 *
 * Where the browser offers no notifications at all it is marked unavailable rather than
 * `disabled`: a disabled button stops firing hover events in most browsers, and the tooltip
 * saying why it cannot be used is the only thing it has left to offer. It stays clickable
 * for the same reason — the click puts that sentence in the toast, for anyone who does not
 * think to hover.
 *
 * `test` is beside it because of the one thing this feature cannot do, which is tell whether
 * a banner it raised was ever drawn. The browser reports that it showed it even when there is
 * no screen to show it on, so a reader who sees nothing has no way to know whether aivis
 * stayed silent or their operating system swallowed it — and the wait for the next real one
 * is unbounded, which made every failure look like patience. One click settles it.
 */
function NotifyToggle({
  notifier,
  onSay,
}: {
  notifier: Notifier
  onSay: (message: string) => void
}): React.JSX.Element {
  const hint = !notifier.supported
    ? 'Your browser only offers notifications to pages on https or a loopback address, and this is neither — reach aivis on localhost or 127.0.0.1 to use them. The count on this tab works regardless.'
    : notifier.permission === 'denied'
      ? 'Your browser is blocking notifications for this page. Allow them in its site settings, then click here again.'
      : notifier.enabled
        ? `On: a system notification when a session asks you something or finishes its turn, and nothing while you are already looking at the session it would be about. This tab has to stay open for them to arrive. ${notifier.raised} raised since this page loaded. Click to turn off.`
        : 'Get a system notification when a session asks you something or finishes its turn, so you hear about it from another window. This tab has to stay open for them to arrive. The count on this tab works either way.'
  return (
    <>
      <button
        className={`linkish notify ${notifier.enabled ? 'notify--on' : ''}`}
        onClick={() => void notifier.toggle().then(onSay)}
        title={hint}
        aria-pressed={notifier.enabled}
        aria-disabled={!notifier.supported}
      >
        {notifier.enabled ? 'notifications on' : 'notify me'}
      </button>
      {notifier.enabled ? (
        <button
          className="linkish"
          onClick={() => onSay(notifier.test())}
          title="Raise one now. If nothing appears on screen or in Notification Center, the browser accepted it and your operating system dropped it — check System Settings › Notifications › your browser, and whether a Focus mode is on."
        >
          test
        </button>
      ) : null}
    </>
  )
}

function QueueRow({
  item,
  busy,
  onOpen,
  onNudge,
  onDismiss,
}: {
  item: AttentionItem
  busy: boolean
  onOpen: () => void
  onNudge: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const copy = copyFor(item)
  const waited = age(item.since)
  return (
    <div className={`qrow qrow--${copy.tone}`}>
      <span className={`dot dot--${copy.dot}`} />
      <span className="qrow__why" title={copy.hint}>
        {copy.why}
      </span>
      <span className="qrow__body">
        <span className="qrow__title" title={item.title}>
          {copy.title}
        </span>
        <span className="qrow__sub">
          <b>{item.projectName}</b>
          {item.kind === 'asking' && item.ask ? (
            <>
              {' · '}
              <span className="tool">{item.ask.header}</span>{' '}
              <span className="tool__detail">
                {item.askKind === 'permission'
                  ? item.answerable
                    ? 'allow or deny it here'
                    : 'only its terminal can decide'
                  : item.ask.count > 1
                    ? `${item.ask.count} questions`
                    : item.answerable
                      ? 'holding for your answer'
                      : 'answer it in its terminal'}
              </span>
            </>
          ) : item.toolName ? (
            <>
              {item.kind === 'stalled' ? ' · silent since ' : ' · last '}
              <span className="tool">{item.toolName}</span>{' '}
              <span className="tool__detail">{item.toolDetail}</span>
            </>
          ) : (
            ' · no tool calls yet'
          )}
        </span>
      </span>
      <span className="qrow__age">waiting {waited}</span>
      <span className="qrow__acts">
        {item.kind === 'stalled' ? (
          <button
            className="act act--go"
            onClick={onNudge}
            disabled={busy}
            title="Send the session the word “continue” over its message socket"
          >
            {busy ? 'Nudging…' : 'Nudge'}
          </button>
        ) : null}
        <button
          className={`act ${item.kind === 'waiting' || item.kind === 'asking' ? 'act--go' : ''}`}
          onClick={onOpen}
          title={
            item.kind === 'asking'
              ? item.answerable
                ? 'Open the session — the card to answer on sits above the composer'
                : 'Open the session. aivis does not drive this one, so the answer has to be given in its own terminal'
              : item.kind === 'waiting'
                ? 'Open the session and clear this row — it comes back if the session runs again and stops again'
                : 'Open the session'
          }
        >
          {item.kind === 'asking' && item.answerable ? 'Answer' : 'Open'}
        </button>
        <button className="act act--mute" onClick={onDismiss} title="Hide this wait until the session moves on">
          Dismiss
        </button>
      </span>
    </div>
  )
}

/** A session that is advancing right now, with the shape of its last few minutes. */
function Tile({ session, onOpen }: { session: Session; onOpen: () => void }): React.JSX.Element {
  // A server older than this build sends no pulse at all, so treat it as no bars rather
  // than letting the spread below throw and take the whole page down with it.
  const pulse = session.pulse ?? []
  const peak = Math.max(1, ...pulse)
  const ceiling = session.contextLimit.tokens
  const used = Math.min(100, Math.round((session.tokens.contextWindow / ceiling) * 100))
  return (
    <button className="tile" onClick={onOpen}>
      <span className="tile__head">
        {/*
          The session's own state, not the section's. A tile is here because something is
          advancing, and when that something is a workflow rather than the session itself
          the dot says `idle` while the running row below says what is actually moving —
          which is the fact worth showing rather than a contradiction to paper over.
        */}
        <span className={`dot dot--${session.status}`} title={session.status} />
        <span className="tile__proj">
          <b>{session.projectName}</b>
          {session.git.branch ? ` · ${session.git.branch}` : ''}
        </span>
        <span className="tile__age">{age(session.startedAt)}</span>
      </span>
      <span className="tile__title" title={session.title}>
        {session.title}
      </span>
      {session.lastActivity ? (
        <span className="tile__now">
          <span className="tool">{session.lastActivity.tool}</span>
          <span className="tool__detail">{session.lastActivity.detail}</span>
        </span>
      ) : (
        <span className="tile__now tile__now--empty">no tool calls yet</span>
      )}
      <RunningTasks tasks={session.background ?? []} />
      <span className="tile__foot">
        <span className="pulse" title={`Tool calls a minute over the last ${pulse.length} minutes`}>
          {pulse.map((calls, index) => (
            <i
              key={index}
              className={calls > 0 ? 'is-on' : ''}
              style={{ height: `${Math.max(2, Math.round((calls / peak) * 16))}px` }}
            />
          ))}
        </span>
        <span className="tile__model">{modelName(session.model)}</span>
        <span className="ctx" title={contextNote(session.tokens.contextWindow, session.contextLimit)}>
          <span className="ctx__bar">
            <i className={used >= 75 ? 'is-warn' : ''} style={{ width: `${used}%` }} />
          </span>
          <span className="ctx__n">
            {fmtTokens(session.tokens.contextWindow)} / {fmtTokens(ceiling)}
          </span>
        </span>
      </span>
    </button>
  )
}

function ProjectRow({
  project,
  defaults,
  open,
  endedOpen,
  onToggle,
  onToggleEnded,
  onOpen,
  onNew,
  onResume,
}: {
  project: Project
  defaults: Defaults | null
  open: boolean
  endedOpen: boolean
  onToggle: () => void
  onToggleEnded: () => void
  onOpen: (id: string) => void
  onNew: () => void
  onResume: (session: Session) => Promise<void>
}): React.JSX.Element {
  const ended = project.sessions.filter((s) => s.status === 'ended')
  const rest = project.sessions.filter((s) => s.status !== 'ended')
  const tally = STATUS_ORDER.map((status) => ({
    status,
    n: project.sessions.filter((s) => s.status === status).length,
  })).filter((entry) => entry.n > 0)

  return (
    <div className={`prow ${open ? 'prow--open' : ''}`}>
      <button className="prow__head" onClick={onToggle}>
        <span className="prow__go">›</span>
        <span className="prow__name">{project.name}</span>
        <span className="prow__path" title={project.cwd}>
          <i>{homePath(project.cwd)}</i>
        </span>
        <span className="prow__tally">
          {tally.map((entry) => (
            <span
              key={entry.status}
              className={`tally tally--${entry.status}`}
              title={hintFor(defaults, entry.status)}
            >
              <span className={`dot dot--${entry.status}`} />
              {entry.n} {entry.status}
            </span>
          ))}
        </span>
        <span className="prow__age">{age(project.lastActivityAt)}</span>
      </button>
      {open ? (
        <div className="prow__body">
          {rest.length > 0 ? (
            <div className="slist">
              {rest.map((session) => (
                <SessionLine
                  key={session.id}
                  session={session}
                  onOpen={() => onOpen(session.id)}
                  onResume={() => void onResume(session)}
                />
              ))}
            </div>
          ) : null}
          {endedOpen && ended.length > 0 ? (
            <div className="slist">
              {ended.map((session) => (
                <SessionLine
                  key={session.id}
                  session={session}
                  onOpen={() => onOpen(session.id)}
                  onResume={() => void onResume(session)}
                />
              ))}
            </div>
          ) : null}
          <div className="prow__foot">
            {ended.length > 0 ? (
              <button className="linkish" onClick={onToggleEnded}>
                {endedOpen ? '▾' : '▸'} {ended.length} ended {ended.length === 1 ? 'session' : 'sessions'}
              </button>
            ) : null}
            <button className="prow__new" onClick={onNew}>
              + New session here
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function SessionLine({
  session,
  where = false,
  onOpen,
  onResume,
}: {
  session: Session
  /** Name the project too, for a list that is not already inside one. */
  where?: boolean
  onOpen: () => void
  onResume: () => void
}): React.JSX.Element {
  return (
    <button className={`sline ${where ? 'sline--where' : ''}`} onClick={onOpen}>
      <span className={`dot dot--${session.status}`} title={session.status} />
      {where ? (
        <span className="sline__where" title={session.cwd}>
          {session.projectName}
        </span>
      ) : null}
      <span className="sline__title" title={session.title}>
        {session.title}
      </span>
      <span className="sline__last">
        {/*
          A running task outranks the last tool call: the call is what the session finished
          doing, the task is what is happening now.
        */}
        {(session.background ?? []).length > 0 ? (
          <RunningTasks tasks={session.background} />
        ) : session.lastActivity ? (
          <>
            <b>{session.lastActivity.tool}</b> {session.lastActivity.detail}
          </>
        ) : (
          'no tool calls'
        )}
      </span>
      <span className="sline__ctx">{fmtTokens(session.tokens.contextWindow)}</span>
      <span className="sline__age">{age(session.lastActivityAt)}</span>
      <span className="sline__act">
        <span
          className="mini"
          role="button"
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation()
            onResume()
          }}
        >
          resume
        </span>
      </span>
    </button>
  )
}
