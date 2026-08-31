import { config } from './config.ts'
import type { AskSummary, AttentionItem, AttentionQueue, PendingAsk, Session } from '../shared/types.ts'

/**
 * What is waiting on you across the whole fleet.
 *
 * The index shows sessions in three registers — advancing, waiting, and everything else —
 * and only the middle one is worth interrupting yourself for. This module builds it. Two
 * of the three kinds fall straight out of session status, and the last out of the question
 * a session recorded asking. All of it comes from the fleet the caller already has, so the
 * queue costs nothing to compute and can be polled freely.
 */

/*
 * One number here is a judgement call rather than a fact, so it is a setting. A live
 * session that stopped a minute ago is holding for your reply; one that stopped yesterday
 * is a terminal you left open, and queueing it would bury the sessions that genuinely
 * stopped just now — past `waitingWindowMs` a session keeps its `idle` status and sits
 * with its project, where its age says plainly how long it has been there.
 */

/**
 * Reduce a decision a driver is holding to the line the index draws.
 *
 * A permission prompt has no questions to summarize, so it says what it is instead: the
 * tool, and whatever Claude Code named as its subject. That row still belongs in this
 * queue — a driven session waiting on one writes nothing at all until it is answered, and
 * without a row it would go quiet for two minutes and then report as `stalled`, whose
 * whole meaning is that aivis does not know why a session stopped. Here, it does.
 */
function heldSummary(ask: PendingAsk): AskSummary {
  const first = ask.questions?.[0]
  return {
    toolUseId: ask.toolUseId,
    header: first?.header ?? ask.displayName,
    // A question is its own strongest line. A permission prompt has none, so the tool and
    // its subject are put together into one: "Write server/attention.ts" reads at a glance
    // where the subject alone — "server/attention.ts" — says nothing about what is wanted.
    question: first?.question ?? (ask.description ? `${ask.displayName} ${ask.description}` : `${ask.displayName} needs a decision`),
    count: ask.questions?.length ?? 1,
    at: ask.at,
  }
}

/**
 * Build the attention queue, longest wait first.
 *
 * `held` carries what each driven session has stopped for, keyed by session id, with an
 * entry present and empty for a driven session holding nothing. Two things come from it
 * that the transcript cannot supply: a permission prompt, which writes no record at all
 * until it is answered, and whether an answer can be given from the browser — a question
 * asked by a session running in a terminal is visible here but not answerable here.
 */
export function attentionQueue(
  sessions: Session[],
  held: Map<string, PendingAsk[]> = new Map(),
): AttentionQueue {
  const items: AttentionItem[] = []

  for (const session of sessions) {
    // A session with no process of its own has nothing left to wait for, with one exception:
    // aivis may be driving it. Pids are attributed to transcripts by directory and recency,
    // which is a guess, and the session likeliest to lose it is the one holding a permission
    // prompt — it writes nothing while it waits, so it sinks to the bottom of its directory's
    // recency order and can come back with no pid at all. Dropping it here would hide the one
    // row this queue exists to show, so the driver's word outranks the process scan's.
    if (session.livePids.length === 0 && !held.has(session.id)) continue

    const base = {
      sessionId: session.id,
      projectName: session.projectName,
      cwd: session.cwd,
      title: session.title,
      toolName: session.lastActivity?.tool ?? null,
      toolDetail: session.lastActivity?.detail ?? null,
    }

    // A decision outranks everything else the session could be reported as: it is the only
    // kind here that the session named itself, and it is holding a turn open rather than
    // describing one that ended.
    //
    // What the driver is holding wins over what the transcript shows, because it is both
    // fresher and richer — it arrives the moment Claude Code asks rather than on the next
    // transcript read, it covers permission prompts, which leave no record until they are
    // answered, and it is the only source that knows an answer can be given from here.
    const driven = held.get(session.id)
    const pending = driven?.[0]
    if (pending) {
      const ask = heldSummary(pending)
      items.push({
        ...base,
        id: `asking:${session.id}:${pending.requestId}`,
        kind: 'asking',
        since: ask.at,
        ask,
        askKind: pending.questions ? 'question' : 'permission',
        answerable: true,
      })
      continue
    }
    if (session.ask) {
      items.push({
        ...base,
        id: `asking:${session.id}:${session.ask.toolUseId}`,
        kind: 'asking',
        since: session.ask.at,
        ask: session.ask,
        askKind: 'question',
        // A driven session whose driver is holding nothing has just been answered and the
        // transcript has not caught up. It is still answerable; it is simply not asking.
        answerable: driven !== undefined,
      })
      continue
    }

    // A live session that has stopped mid-turn, or has finished and is holding for you.
    //
    // Except when it is finished with its turn and not with its work. A session that hands
    // off a workflow or a subagent ends the turn the moment the work is accepted, so from
    // the transcript it looks exactly like one holding for your reply — and it is the
    // opposite: nothing is wanted from you, and Claude Code will pick the conversation back
    // up itself when the work reports in. Queueing that as waiting puts the busiest session
    // on the machine at the top of the list of things that have stopped for you.
    const waitedMs = Date.now() - new Date(session.lastActivityAt).getTime()
    const handedOff = (session.background ?? []).length > 0
    if (session.status === 'idle' && !handedOff && waitedMs < config.waitingWindowMs) {
      items.push({ ...base, id: `waiting:${session.id}:${session.lastActivityAt}`, kind: 'waiting', since: session.lastActivityAt, ask: null, askKind: null, answerable: false })
    } else if (session.status === 'stalled') {
      items.push({ ...base, id: `stalled:${session.id}:${session.lastActivityAt}`, kind: 'stalled', since: session.lastActivityAt, ask: null, askKind: null, answerable: false })
    }
  }

  // Longest wait first, except that sessions holding for a decision come first as a group.
  // Everything else in this queue is a session that stopped and left aivis to work out why;
  // these are the ones that said what they want, and they are holding a turn open until
  // they get it. Sorting them purely by age would file a question asked a minute ago below
  // a terminal somebody left open this morning, which is the wrong way round for the only
  // items that are truly blocked.
  const rank = (item: AttentionItem): number => (item.kind === 'asking' ? 0 : 1)
  items.sort((a, b) => rank(a) - rank(b) || a.since.localeCompare(b.since))
  return { items, scannedAt: new Date().toISOString() }
}
