/**
 * What `server/attention.ts` puts in front of you, and what it deliberately leaves out.
 *
 * The queue is the one part of the index that claims something has stopped for you, so a
 * row it should not have drawn costs more than a missing one: it sends you into a session
 * to look for a question nobody asked. These assertions state the three kinds it draws and
 * the case that looks exactly like one of them and is its opposite — a session that
 * finished its turn because it handed the work off, and is spending more than anything else
 * on the machine while it appears to wait.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attentionQueue } from '../server/attention.ts'
import type { BackgroundTask, PendingAsk, Session } from '../shared/types.ts'

const MINUTE = 60_000

/** A live session that finished its turn a minute ago, which is the queue's `waiting` case. */
function session(over: Partial<Session> = {}): Session {
  const at = new Date(Date.now() - MINUTE).toISOString()
  return {
    id: 'b8e04d71-0000-4000-8000-000000000001',
    cwd: '/work/app',
    projectName: 'app',
    transcriptPath: '/store/app/b8e04d71-0000-4000-8000-000000000001.jsonl',
    title: 'ship the thing',
    status: 'idle',
    startedAt: at,
    lastActivityAt: at,
    model: 'claude-opus-5',
    effort: null,
    contextLimit: { tokens: 200_000, source: 'model' },
    permissionMode: null,
    version: null,
    userTurns: 1,
    assistantTurns: 1,
    toolCalls: 1,
    subagentTurns: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, contextWindow: 1000 },
    git: { branch: null, filesChanged: 0, insertions: 0, deletions: 0, isRepo: false },
    lastActivity: { tool: 'Workflow', detail: 'audit the tree', at },
    ask: null,
    background: [],
    livePids: [4242],
    isForeground: true,
    sampled: false,
    transcriptBytes: 100,
    pulse: [],
    ...over,
  }
}

function task(over: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    toolUseId: 'toolu_01DzpS9P1WJGAduc6eeEzaPT',
    tool: 'Workflow',
    detail: 'audit the tree',
    at: new Date(Date.now() - MINUTE).toISOString(),
    ...over,
  }
}

test('a live session that finished its turn a minute ago is waiting on you', () => {
  const queue = attentionQueue([session()])
  assert.equal(queue.items.length, 1)
  assert.equal(queue.items[0]?.kind, 'waiting')
})

/*
 * The case this file exists for. The turn that launches a workflow ends the moment the work
 * is accepted, so the transcript of a session running fourteen agents is byte for byte the
 * shape of one holding for your reply. Reading it as waiting put the busiest session on the
 * machine at the top of the list of things that had stopped for you, and nothing had.
 */
test('a session that finished its turn by handing the work off is not waiting on anybody', () => {
  const queue = attentionQueue([session({ background: [task()] })])
  assert.deepEqual(queue.items, [])
})

test('the row comes back the moment the work reports in, since then the turn really has ended', () => {
  const handed = session({ background: [task()] })
  assert.deepEqual(attentionQueue([handed]).items, [])
  assert.equal(attentionQueue([{ ...handed, background: [] }]).items[0]?.kind, 'waiting')
})

/*
 * Only the `waiting` reading is inferred from a finished turn, so only it can be wrong this
 * way. A session that stopped mid-turn is stuck whatever else it has running — the work it
 * handed off cannot finish the turn its own thread abandoned — and a question it asked is
 * still unanswered, so both stay in the queue.
 */
test('background work does not excuse a stall, which is its own thread being stuck', () => {
  const stalled = session({
    status: 'stalled',
    background: [task()],
    lastActivityAt: new Date(Date.now() - 10 * MINUTE).toISOString(),
  })
  assert.equal(attentionQueue([stalled]).items[0]?.kind, 'stalled')
})

test('background work does not answer a question the session stopped to ask', () => {
  const at = new Date(Date.now() - MINUTE).toISOString()
  const asking = session({
    background: [task()],
    ask: { toolUseId: 'toolu_ask', header: 'Approach', question: 'which way?', count: 1, at },
  })
  const queue = attentionQueue([asking])
  assert.equal(queue.items[0]?.kind, 'asking')
  assert.equal(queue.items[0]?.answerable, false)
})

/** A permission prompt, which is the kind of decision that writes no record while it waits. */
function permissionAsk(over: Partial<PendingAsk> = {}): PendingAsk {
  return {
    requestId: 'req-2',
    toolUseId: 'toolu_perm_2',
    toolName: 'Bash',
    displayName: 'Bash',
    questions: null,
    input: { command: 'npm test' },
    description: 'npm test',
    reason: null,
    suggestions: [],
    at: new Date(Date.now() - MINUTE).toISOString(),
    ...over,
  }
}

/*
 * A session with no process of its own has nothing left to wait for, and the queue drops it
 * before it looks at anything else. The exception below is the reason that drop is
 * conditional rather than absolute. Pids are attributed to transcripts by directory and
 * recency, and the session likeliest to lose that guess is one aivis drives: it writes
 * nothing while it waits on a decision, so it sinks to the bottom of its directory's recency
 * order and a terminal somebody started in the same checkout takes the pid instead. Its
 * driver is holding the child and the prompt, so dropping it here would hide the one row
 * this queue exists to draw.
 */
test('a driven session whose pid the scan lost still shows the prompt its driver is holding', () => {
  const lost = session({ livePids: [], isForeground: false, status: 'working' })
  const queue = attentionQueue([lost], new Map([[lost.id, [permissionAsk()]]]))
  assert.equal(queue.items.length, 1)
  assert.equal(queue.items[0]?.kind, 'asking')
  assert.equal(queue.items[0]?.answerable, true)
})

/*
 * The other half of the same rescue, and the one that needs the fleet to have done its part:
 * a driven session that stopped because its turn ended rather than because it asked
 * something. The entry in `held` is present and empty, which is what "aivis is driving this
 * and it is holding nothing" looks like, and the status has to be the one its transcript
 * implies — a scan that reported `ended` here would draw no row at all.
 */
test('a driven session that simply finished its turn is waiting on you, pid or no pid', () => {
  const lost = session({ livePids: [], isForeground: false })
  const queue = attentionQueue([lost], new Map([[lost.id, []]]))
  assert.equal(queue.items.length, 1)
  assert.equal(queue.items[0]?.kind, 'waiting')
})

test('a session with no process and nobody driving it has nothing left to wait for', () => {
  const gone = session({ livePids: [], isForeground: false, status: 'ended' })
  assert.deepEqual(attentionQueue([gone]).items, [])
  // Still nothing when another session is the driven one: the rescue is per session.
  assert.deepEqual(attentionQueue([gone], new Map([['some-other-session', []]])).items, [])
})

test('a permission prompt the driver is holding outranks everything, background work included', () => {
  const pending: PendingAsk = {
    requestId: 'req-1',
    toolUseId: 'toolu_perm',
    toolName: 'Write',
    displayName: 'Write',
    questions: null,
    input: { file_path: 'server/attention.ts' },
    description: 'server/attention.ts',
    reason: null,
    suggestions: [],
    at: new Date(Date.now() - MINUTE).toISOString(),
  }
  const held = new Map([[session().id, [pending]]])
  const queue = attentionQueue([session({ background: [task()] })], held)
  assert.equal(queue.items[0]?.kind, 'asking')
  assert.equal(queue.items[0]?.askKind, 'permission')
  assert.equal(queue.items[0]?.answerable, true)
})
