/**
 * What `server/transcripts.ts` folds a transcript into, and what it derives from that fold.
 *
 * Every assertion here is about something that fails silently: a status that mislabels a
 * session on the index, a question that surfaces when nobody can answer it, a token total
 * that is quietly wrong. None of these throw in production, so the only way to notice a
 * regression is to state the expected reading here.
 *
 * The folding logic itself is not exported, so it is driven the way the server drives it:
 * a real `.jsonl` file under the temp directory, read back through `TranscriptIndex`.
 * Record shapes follow `scripts/make-fixtures.mjs`, which mirrors what Claude Code writes.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TranscriptIndex, isPlausibleSessionId, toSession } from '../server/transcripts.ts'
import { readTranscript } from '../server/transcriptView.ts'
import type { Session } from '../shared/types.ts'

/** The accumulator type is internal, so it is named through the exported surface. */
type Accumulator = NonNullable<Awaited<ReturnType<TranscriptIndex['ingest']>>>

const tempDirs: string[] = []

after(async () => {
  for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true })
})

async function newTranscript(body: string, name = 'b8e04d71-0000-4000-8000-000000000001.jsonl'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aivis-transcripts-'))
  tempDirs.push(dir)
  const file = path.join(dir, name)
  await fs.writeFile(file, body)
  return file
}

/**
 * Run `fn` with the log captured, so a test can say what was reported and how often.
 *
 * A file the index gives up on says so on standard error, and the tests that make one do
 * not want it in the suite's output any more than a user wants it once a refresh.
 */
async function captureErrors(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(' '))
  try {
    await fn()
  } finally {
    console.error = original
  }
  return lines
}

const asJsonl = (rows: unknown[]): string => rows.map((row) => JSON.stringify(row)).join('\n') + '\n'

/** Write these records to a fresh transcript and read them back through the index. */
async function fold(rows: unknown[]): Promise<Accumulator> {
  const file = await newTranscript(asJsonl(rows))
  const acc = await new TranscriptIndex().ingest(file)
  assert.ok(acc, 'a transcript with timestamped records should fold into an accumulator')
  return acc
}

// --- Record builders, matching the shapes a real transcript uses -------------------------

const CWD = '/home/dev/code/acme/checkout-api'
const base = { sessionId: 'sess-abc', cwd: CWD, gitBranch: 'pricing-tiers', version: '2.0.0', permissionMode: 'auto' }

/** An ISO timestamp `ms` milliseconds in the past, which is how status is judged. */
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()

const text = (value: string) => ({ type: 'text', text: value })
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({
  type: 'tool_use',
  id,
  name,
  input,
})
const askBlock = (id: string, questions: unknown[]) => toolUse(id, 'AskUserQuestion', { questions })

const usage = (input: number, output: number, cacheRead: number, cacheCreation: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheCreation,
})

interface AssistantOpts {
  at?: string
  usage?: Record<string, number>
  effort?: string
  sidechain?: boolean
  stopReason?: string
  model?: string
}

function assistant(content: unknown[], opts: AssistantOpts = {}): Record<string, unknown> {
  const record: Record<string, unknown> = {
    ...base,
    type: 'assistant',
    timestamp: opts.at ?? ago(0),
    message: {
      role: 'assistant',
      model: opts.model ?? 'claude-opus-5',
      ...(opts.stopReason ? { stop_reason: opts.stopReason } : {}),
      content,
      ...(opts.usage ? { usage: opts.usage } : {}),
    },
  }
  if (opts.effort) record.effort = opts.effort
  if (opts.sidechain) record.isSidechain = true
  return record
}

function userPrompt(
  value: string,
  opts: { at?: string; sidechain?: boolean; meta?: boolean } = {},
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    ...base,
    type: 'user',
    timestamp: opts.at ?? ago(0),
    message: { role: 'user', content: [text(value)] },
  }
  if (opts.sidechain) record.isSidechain = true
  if (opts.meta) record.isMeta = true
  return record
}

function toolResult(toolUseId: string, opts: { at?: string; sidechain?: boolean } = {}): Record<string, unknown> {
  const record: Record<string, unknown> = {
    ...base,
    type: 'user',
    timestamp: opts.at ?? ago(0),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done' }] },
  }
  if (opts.sidechain) record.isSidechain = true
  return record
}

/** A message pushed into a running session over its socket, which aivis is the source of. */
const queuedCommand = (prompt: unknown, at = ago(0)) => ({
  ...base,
  type: 'attachment',
  timestamp: at,
  attachment: { type: 'queued_command', prompt },
})

const summaryRecord = (value: string) => ({ type: 'summary', summary: value, sessionId: base.sessionId })

// --- Display record ---------------------------------------------------------------------

type SessionOpts = Parameters<typeof toSession>[2]

/**
 * Build the display record with the process-level facts the transcript cannot know.
 * Defaults describe a dead session; each test overrides only what it is about.
 */
function display(acc: Accumulator, over: Partial<SessionOpts> = {}): Session {
  return toSession(path.join(CWD, 'sess-abc.jsonl'), acc, {
    livePids: [],
    isForeground: false,
    git: { branch: 'pricing-tiers', filesChanged: 0, insertions: 0, deletions: 0, isRepo: true },
    contextLimit: { tokens: 200_000, source: 'assumed' },
    staleAfterMs: 2 * 60_000,
    askWindowMs: 4 * 3600_000,
    taskWindowMs: 6 * 3600_000,
    sampled: false,
    transcriptBytes: 0,
    ...over,
  })
}

const ALIVE = { livePids: [4242], isForeground: true }

// --- Status derivation ------------------------------------------------------------------

test('a session with no live process is ended, and parked instead when aivis has seen it running', async () => {
  const acc = await fold([
    userPrompt('Trace the double charge in the tier resolver.', { at: ago(60_000) }),
    assistant([text('Done.')], { at: ago(30_000), stopReason: 'end_turn' }),
  ])

  // Liveness is decided before anything the transcript says, so a finished turn that would
  // otherwise read as `idle` still reports as `ended` once its process is gone.
  assert.equal(display(acc).status, 'ended')
  assert.equal(display(acc, { parked: true }).status, 'parked')
})

test('a live session whose last assistant turn ended is idle rather than stalled, however long ago it ended', async () => {
  const acc = await fold([
    userPrompt('Add the retry affordance.', { at: ago(20 * 60_000) }),
    assistant([text('Done, 24 tests pass.')], { at: ago(10 * 60_000), stopReason: 'end_turn' }),
  ])

  // Ten minutes of silence is well past the two-minute stale window, but a turn that ended
  // is not silent for an unknown reason: it is waiting on a person.
  assert.equal(display(acc, ALIVE).status, 'idle')
})

test('a live session holding a question reports working rather than stalled, because the reason it stopped is known', async () => {
  const acc = await fold([
    userPrompt('Where is the proration applied twice?', { at: ago(30 * 60_000) }),
    assistant([text('Two ways to fix this.'), askBlock('toolu-ask-1', [{ question: 'Move it or flag it?', header: 'Fix shape' }])], {
      at: ago(10 * 60_000),
    }),
  ])

  const session = display(acc, ALIVE)
  assert.equal(session.status, 'working')
  assert.equal(session.ask?.question, 'Move it or flag it?')
})

test('a live session whose decision the driver is holding reports working, because a permission prompt writes no record while it waits', async () => {
  const acc = await fold([
    userPrompt('Backfill the tier ids.', { at: ago(30 * 60_000) }),
    assistant([toolUse('toolu-bash-1', 'Bash', { command: 'python -m tools.backfill --verify' })], { at: ago(10 * 60_000) }),
    toolResult('toolu-bash-1', { at: ago(10 * 60_000) }),
  ])

  assert.equal(display(acc, ALIVE).status, 'stalled', 'without the driver saying so, this silence is a stall')
  assert.equal(display(acc, { ...ALIVE, heldByDriver: true }).status, 'working')
})

test('a live session silent past staleAfterMs with nothing to wait on is stalled', async () => {
  const acc = await fold([
    userPrompt('Backfill the tier ids.', { at: ago(30 * 60_000) }),
    // A tool call with no result after it is what a session stuck inside a long command
    // looks like from outside, and is the case `stalled` exists to name.
    assistant([toolUse('toolu-bash-2', 'Bash', { command: 'python -m tools.backfill --verify' })], { at: ago(10 * 60_000) }),
  ])

  assert.equal(display(acc, ALIVE).status, 'stalled')
})

test('a live session that moved within staleAfterMs is working', async () => {
  const acc = await fold([
    userPrompt('Backfill the tier ids.', { at: ago(60_000) }),
    assistant([toolUse('toolu-bash-3', 'Bash', { command: 'python -m tools.backfill --verify' })], { at: ago(5_000) }),
  ])

  assert.equal(display(acc, ALIVE).status, 'working')
})

// --- Question lifecycle -----------------------------------------------------------------

test('an AskUserQuestion call opens a question and reports its header, text and how many were asked', async () => {
  const acc = await fold([
    userPrompt('Where is the proration applied twice?', { at: ago(60_000) }),
    assistant(
      [
        askBlock('toolu-ask-2', [
          { question: 'Should proration move out of ledger.post()?', header: 'Fix shape' },
          { question: 'Do you want the legacy path covered?', header: 'Scope' },
        ]),
      ],
      { at: ago(30_000) },
    ),
  ])

  assert.equal(acc.ask?.toolUseId, 'toolu-ask-2')
  assert.equal(acc.ask?.header, 'Fix shape')
  assert.equal(acc.ask?.question, 'Should proration move out of ledger.post()?')
  assert.equal(acc.ask?.count, 2, 'the index draws how many questions came in the one call')

  // A call with no header of its own still has to render as something.
  const unheaded = await fold([assistant([askBlock('toolu-ask-3', [{ question: 'Which one?' }])], { at: ago(30_000) })])
  assert.equal(unheaded.ask?.header, 'Question')
})

test('a question stays open while the other tool results of its turn come back, and closes only on its own result', async () => {
  const turn = [
    userPrompt('Where is the proration applied twice?', { at: ago(120_000) }),
    assistant(
      [
        toolUse('toolu-read-1', 'Read', { file_path: `${CWD}/app/ledger/post.py` }),
        askBlock('toolu-ask-4', [{ question: 'Move it or flag it?', header: 'Fix shape' }]),
      ],
      { at: ago(90_000) },
    ),
  ]

  // The read comes back first. Clearing on any result at all would lose the question here.
  const stillOpen = await fold([...turn, toolResult('toolu-read-1', { at: ago(60_000) })])
  assert.equal(stillOpen.ask?.toolUseId, 'toolu-ask-4')

  const answered = await fold([...turn, toolResult('toolu-read-1', { at: ago(60_000) }), toolResult('toolu-ask-4', { at: ago(30_000) })])
  assert.equal(answered.ask, null, 'the answer arrives as the question call’s own result')
})

test('an assistant turn that ends clears the open question, whether it was answered elsewhere or cut short', async () => {
  const acc = await fold([
    assistant([askBlock('toolu-ask-5', [{ question: 'Move it or flag it?', header: 'Fix shape' }])], { at: ago(120_000) }),
    assistant([text('Going with the flag.')], { at: ago(60_000), stopReason: 'end_turn' }),
  ])

  assert.equal(acc.ask, null)
})

test('a user prompt clears the open question, which is the shape an interrupted question leaves behind', async () => {
  const acc = await fold([
    assistant([askBlock('toolu-ask-6', [{ question: 'Move it or flag it?', header: 'Fix shape' }])], { at: ago(120_000) }),
    // No tool_result: the person typed over the question instead of answering it.
    userPrompt('Forget that, look at legacy_pricing.py first.', { at: ago(60_000) }),
  ])

  assert.equal(acc.ask, null)
  assert.equal(acc.userTurns, 1)
})

test('a question asked inside a subagent never surfaces, because a subagent has no user to answer it', async () => {
  const acc = await fold([
    userPrompt('Review the pricing path with an agent.', { at: ago(120_000) }),
    assistant([askBlock('toolu-ask-7', [{ question: 'Which module first?', header: 'Order' }])], {
      at: ago(60_000),
      sidechain: true,
    }),
  ])

  assert.equal(acc.ask, null)
  assert.equal(display(acc, ALIVE).ask, null)
})

test('a question older than the ask window stops being reported, so an abandoned terminal does not sit at the top of the queue', async () => {
  const acc = await fold([
    userPrompt('Where is the proration applied twice?', { at: ago(7 * 3600_000) }),
    assistant([askBlock('toolu-ask-8', [{ question: 'Move it or flag it?', header: 'Fix shape' }])], { at: ago(6 * 3600_000) }),
  ])

  assert.ok(acc.ask, 'the transcript still holds the question that was never answered')
  const session = display(acc, { ...ALIVE, askWindowMs: 4 * 3600_000 })
  assert.equal(session.ask, null)
  // With the question gone there is nothing to explain six hours of silence, so the
  // session falls through to the stale rung rather than staying `working`.
  assert.equal(session.status, 'stalled')
})

test('a question is not reported when no process is left to receive the answer', async () => {
  const acc = await fold([
    assistant([askBlock('toolu-ask-9', [{ question: 'Move it or flag it?', header: 'Fix shape' }])], { at: ago(60_000) }),
  ])

  assert.ok(acc.ask)
  const session = display(acc, { livePids: [] })
  assert.equal(session.ask, null)
  assert.equal(session.status, 'ended')
})

// --- Sidechain accounting ---------------------------------------------------------------

test('subagent records count as subagent turns rather than assistant turns, while their tool calls still count as activity', async () => {
  const acc = await fold([
    userPrompt('Review the pricing path with two agents.', { at: ago(180_000) }),
    assistant([toolUse('toolu-task-1', 'Task', { description: 'Review pricing' })], { at: ago(150_000) }),
    assistant([toolUse('toolu-grep-1', 'Grep', { pattern: 'apply_proration' })], { at: ago(120_000), sidechain: true }),
    assistant([toolUse('toolu-read-2', 'Read', { file_path: `${CWD}/app/ledger/post.py` })], { at: ago(90_000), sidechain: true }),
    assistant([text('Both agents are back.')], { at: ago(60_000), stopReason: 'end_turn' }),
  ])

  assert.equal(acc.subagentTurns, 2, 'both records marked isSidechain belong to the agent, not the session')
  assert.equal(acc.assistantTurns, 2, 'only the dispatching turn and the closing turn are the main thread’s')
  // A session running agents is busy whatever its own thread is doing between them, so
  // their calls count toward tool activity.
  assert.equal(acc.toolCalls, 3)

  // A subagent turn also cannot move the main thread's shape: the closing `end_turn` above
  // is what status reads, and the subagent records between do not overwrite it.
  assert.equal(display(acc, ALIVE).status, 'idle')
})

test('a subagent dispatched at lower effort does not report the session as having dropped effort', async () => {
  const acc = await fold([
    assistant([toolUse('toolu-task-2', 'Task', { description: 'Review pricing' })], { at: ago(120_000), effort: 'high' }),
    assistant([text('Reading.')], { at: ago(90_000), effort: 'low', sidechain: true }),
  ])

  assert.equal(acc.effort, 'high')
})

test('subagent tokens count toward the totals but never toward the context window, which is the main thread’s alone', async () => {
  const acc = await fold([
    assistant([text('Dispatching.')], { at: ago(120_000), usage: usage(100, 10, 1_000, 50) }),
    assistant([text('Agent output.')], { at: ago(60_000), usage: usage(9_000, 20, 90_000, 900), sidechain: true }),
  ])

  assert.deepEqual(acc.tokens, {
    input: 9_100,
    output: 30,
    cacheRead: 91_000,
    cacheCreation: 950,
    // The main turn's own 100 + 1000 + 50; the agent's much larger prompt is not this
    // session's context, and reading it as such would show a session about to overflow.
    contextWindow: 1_150,
  })
})

// --- Token accumulation -----------------------------------------------------------------

test('token totals accumulate across turns while the context window is the latest main-thread turn rather than a running sum', async () => {
  const acc = await fold([
    userPrompt('Trace the double charge.', { at: ago(180_000) }),
    assistant([toolUse('toolu-read-3', 'Read', { file_path: `${CWD}/app/pricing/tier_resolver.py` })], {
      at: ago(150_000),
      usage: usage(100, 10, 1_000, 50),
    }),
    toolResult('toolu-read-3', { at: ago(120_000) }),
    assistant([text('Found it.')], { at: ago(60_000), stopReason: 'end_turn', usage: usage(300, 20, 5_000, 100) }),
  ])

  assert.equal(acc.tokens.input, 400)
  assert.equal(acc.tokens.output, 30)
  assert.equal(acc.tokens.cacheRead, 6_000)
  assert.equal(acc.tokens.cacheCreation, 150)
  // The window a turn ran in is what that turn was sent, so it is the last turn's
  // input + cache read + cache creation, and output is no part of it.
  assert.equal(acc.tokens.contextWindow, 5_400)
})

// --- Title selection --------------------------------------------------------------------

test('the first user prompt becomes the title and no later prompt replaces it', async () => {
  const acc = await fold([
    userPrompt('The tier resolver double-charges when a plan changes mid-cycle.', { at: ago(180_000) }),
    assistant([text('Looking.')], { at: ago(120_000), stopReason: 'end_turn' }),
    userPrompt('Also check the legacy path.', { at: ago(60_000) }),
    summaryRecord('Tracing a double-charge in the tier resolver'),
  ])

  assert.equal(acc.title, 'The tier resolver double-charges when a plan changes mid-cycle.')
  assert.equal(acc.userTurns, 2)
  assert.equal(display(acc).title, acc.title, 'a summary never displaces a prompt that exists')
})

test('a long first prompt is cut to a title-sized line rather than carried whole', async () => {
  const long = 'Trace the proration bug '.repeat(20)
  const acc = await fold([userPrompt(long, { at: ago(60_000) })])

  assert.ok(acc.title)
  assert.equal(acc.title.length, 120, 'the title is capped at 120 characters')
  assert.ok(acc.title.endsWith('…'), 'the cut is marked, so nobody reads it as the whole prompt')
})

test('a message pushed in over the socket counts as a user turn and can supply the title', async () => {
  const typed = await fold([queuedCommand('Run the checkout suite before you touch anything else.', ago(60_000))])
  assert.equal(typed.userTurns, 1, 'somebody made this prompt, whatever kind of record Claude Code files it as')
  assert.equal(typed.title, 'Run the checkout suite before you touch anything else.')

  // A pushed message that carried an image is a block array rather than a string, and its
  // text has to be read out the same way.
  const withImage = await fold([
    queuedCommand([{ type: 'image', source: { type: 'base64' } }, text('Match this mock.')], ago(60_000)),
  ])
  assert.equal(withImage.title, 'Match this mock.')
  assert.equal(withImage.userTurns, 1)

  // An empty push is not a turn at all.
  const empty = await fold([userPrompt('Start here.', { at: ago(120_000) }), queuedCommand('   ', ago(60_000))])
  assert.equal(empty.userTurns, 1)
})

test('a summary record titles a session only when no prompt was ever typed', async () => {
  const summarized = await fold([
    assistant([text('Continuing from before.')], { at: ago(60_000), stopReason: 'end_turn' }),
    summaryRecord('Load test harness for the quote endpoint'),
  ])
  assert.equal(display(summarized).title, 'Load test harness for the quote endpoint')

  const bare = await fold([assistant([text('Continuing from before.')], { at: ago(60_000), stopReason: 'end_turn' })])
  assert.equal(display(bare).title, '(no prompt yet)')
})

test('text Claude Code injects into the transcript is neither a user turn nor a title', async () => {
  const acc = await fold([
    userPrompt('<command-name>/compact</command-name>', { at: ago(300_000) }),
    userPrompt('<system-reminder>Remember the style guide.</system-reminder>', { at: ago(270_000) }),
    userPrompt('<local-command-stdout>ok</local-command-stdout>', { at: ago(240_000) }),
    userPrompt('<user-prompt-submit-hook>context injected by a hook</user-prompt-submit-hook>', {
      at: ago(225_000),
    }),
    userPrompt('Caveat: The messages below were generated by a previous session.', { at: ago(210_000) }),
    userPrompt('   ', { at: ago(180_000) }),
    userPrompt('A meta record the harness wrote.', { at: ago(150_000), meta: true }),
    userPrompt('A prompt a subagent was handed.', { at: ago(120_000), sidechain: true }),
    userPrompt('The tier resolver double-charges.', { at: ago(60_000) }),
  ])

  assert.equal(acc.userTurns, 1, 'only the one line a person actually typed is a turn')
  assert.equal(acc.title, 'The tier resolver double-charges.')
})

/*
 * Stopping a turn — Escape in the terminal, or the stop aivis offers — files a plain user
 * record reading '[Request interrupted by user]', with nothing but the text to say it is
 * not a prompt. Counted as one it inflated the turn count and left the session `working`,
 * which then aged into `stalled`, so every session anybody had ever interrupted became a
 * permanent 'needs you' entry for a session sitting idle at its prompt.
 */
test('a stopped turn is not a prompt, and leaves the session idle rather than ageing into stalled', async () => {
  const acc = await fold([
    userPrompt('Backfill the tier ids.', { at: ago(30 * 60_000) }),
    assistant([askBlock('toolu-ask-stop', [{ question: 'Move it or flag it?', header: 'Fix shape' }])], {
      at: ago(20 * 60_000),
    }),
    // The other ending the marker comes with, which is why only its opening is matched.
    userPrompt('[Request interrupted by user for tool use]', { at: ago(10 * 60_000) }),
  ])

  assert.equal(acc.userTurns, 1, 'pressing Escape is not something anybody typed')
  assert.equal(acc.lastShape, 'assistant-end')
  assert.equal(acc.ask, null, 'the interrupt is what stopped the question being asked')
  assert.equal(display(acc, ALIVE).status, 'idle')

  // Interrupting before typing anything leaves the session untitled rather than titled by
  // the marker, which is what the first prompt of a transcript is used for.
  const straight = await fold([userPrompt('[Request interrupted by user]', { at: ago(60_000) })])
  assert.equal(straight.userTurns, 0)
  assert.equal(display(straight, ALIVE).title, '(no prompt yet)')

  // Only the opening position counts, the same way it does for a wrapper: a prompt that
  // talks about the marker is still a prompt.
  const about = await fold([userPrompt('why does [Request interrupted by user] count as a prompt?', { at: ago(60_000) })])
  assert.equal(about.userTurns, 1)
})

/*
 * The fold is not the only thing that counts prompts: the session page recounts them from
 * the conversation once it has loaded, and titles an untitled session from the first thing
 * that reader calls a user entry. So the two have to agree, or the count on screen jumps as
 * the page finishes loading and the marker becomes the page's title — which is what the
 * fold's own fix left behind, because it did not reach the conversation reader.
 */
test('the conversation reader and the fold agree on how many prompts a stopped session has', async () => {
  const file = await newTranscript(
    asJsonl([
      userPrompt('Backfill the tier ids.', { at: ago(180_000) }),
      assistant([toolUse('toolu-stop-1', 'Bash', { command: 'psql -c "select 1"' })], { at: ago(120_000) }),
      userPrompt('[Request interrupted by user for tool use]', { at: ago(90_000) }),
      userPrompt('[Request interrupted by user]', { at: ago(60_000) }),
    ]),
  )

  const acc = await new TranscriptIndex().ingest(file)
  assert.ok(acc)
  assert.equal(acc.userTurns, 1)

  const page = await readTranscript(file, 'sess-abc', 500)
  const prompts = page.entries.filter((entry) => entry.kind === 'user' || entry.kind === 'queued')
  assert.equal(prompts.length, acc.userTurns, 'the count on the page is the count the fleet reports')

  const first = page.entries.find((entry) => entry.kind === 'user')
  assert.equal(
    first?.kind === 'user' ? first.text : null,
    'Backfill the tier ids.',
    'the page titles an untitled session from this, so it must not be the marker',
  )
})

/*
 * A transcript is a file anything on the machine can write, and `TranscriptRecord` is an
 * assertion about `JSON.parse` rather than a check of it. A header field of the wrong type
 * used to be copied straight into the accumulator, and the throw came later and elsewhere:
 * `path.join` on a numeric cwd raises inside the fleet's scan, which has no guard of its
 * own, so one hand-written line stopped every session on the machine from being read.
 */
test('a header field that is not a string is ignored rather than carried into the fleet', async () => {
  const poisoned = {
    type: 'user',
    sessionId: { evil: true },
    cwd: 1234,
    gitBranch: ['main'],
    version: true,
    permissionMode: 7,
    timestamp: 1_700_000_000_000,
    message: { role: 'user', content: [text('A prompt on a record with a rotten header.')] },
  }

  const acc = await fold([userPrompt('Trace the double charge.', { at: ago(60_000) }), poisoned])
  assert.equal(acc.cwd, CWD, 'the good record\'s cwd stands; a number does not replace it')
  assert.equal(acc.sessionId, base.sessionId)
  assert.equal(acc.gitBranch, base.gitBranch)
  assert.equal(acc.version, base.version)
  assert.equal(acc.permissionMode, base.permissionMode)
  assert.equal(typeof acc.lastActivityAt, 'string', 'a numeric timestamp is not an activity time')
  assert.equal(acc.userTurns, 2, 'the record is still read; only its rotten fields are dropped')
  // The whole point of the guard: what the fleet spends these on does not throw.
  assert.doesNotThrow(() => path.join(display(acc).cwd, '.claude'))

  // A transcript that carries nothing but the rotten record has no activity time either, so
  // it yields no session at all rather than one the scan chokes on.
  const alone = await newTranscript(asJsonl([poisoned]))
  assert.equal(await new TranscriptIndex().ingest(alone), null)
})

// --- Incremental reading ----------------------------------------------------------------

test('a second read parses only the appended bytes, including a record split across the two reads', async () => {
  const first = userPrompt('Trace the double charge.', { at: ago(180_000) })
  const second = assistant([toolUse('toolu-read-4', 'Read', { file_path: `${CWD}/app/ledger/post.py` })], { at: ago(120_000) })
  const third = assistant([text('Found it.')], { at: ago(60_000), stopReason: 'end_turn' })

  const secondLine = JSON.stringify(second)
  const cut = Math.floor(secondLine.length / 2)
  // A transcript is appended to line by line, so a read can land mid-line. The half-written
  // record must be held rather than parsed, and must not be lost or counted twice when the
  // rest of it arrives.
  const file = await newTranscript(JSON.stringify(first) + '\n' + secondLine.slice(0, cut))

  const index = new TranscriptIndex()
  const partial = await index.ingest(file)
  assert.ok(partial)
  assert.equal(partial.userTurns, 1)
  assert.equal(partial.assistantTurns, 0, 'half a record is not a record')

  await fs.appendFile(file, secondLine.slice(cut) + '\n' + JSON.stringify(third) + '\n')
  const complete = await index.ingest(file)
  assert.ok(complete)
  assert.equal(complete.assistantTurns, 2, 'the straddled record is joined up and counted exactly once')
  assert.equal(complete.userTurns, 1, 'the records read the first time are not read again')
  assert.equal(complete.toolCalls, 1)
  assert.equal(index.sizeOf(file), (await fs.stat(file)).size)
  assert.equal(index.isSampled(file), false)
})

/*
 * The boundary a read stops at is a byte, not a character. Decoding each side of it on its
 * own replaced the halves of a split character with U+FFFD, in a line that still parsed as
 * JSON afterwards — so the loss showed up as garbage in a title or a tool detail, while the
 * session page, which reads the file its own way, drew the same record intact.
 */
test('a character split across two reads is joined back up rather than decoded in halves', async () => {
  const said = 'Trace the double charge in the tarif résolveur — 支払い.'
  const bytes = Buffer.from(JSON.stringify(userPrompt(said, { at: ago(60_000) })) + '\n', 'utf8')
  const inside = bytes.findIndex((byte) => byte > 0x7f) + 1
  assert.ok(inside > 1, 'the fixture has to carry a multi-byte character to cut through')

  const file = await newTranscript('')
  await fs.appendFile(file, bytes.subarray(0, inside))
  const index = new TranscriptIndex()
  assert.equal(await index.ingest(file), null, 'half a record, and half a character, is not a record')

  await fs.appendFile(file, bytes.subarray(inside))
  const acc = await index.ingest(file)
  assert.equal(acc?.title, said)
})

/*
 * One file nobody can read used to abort the whole scan. `Fleet.refresh` reads every
 * transcript in a single pass with no guard of its own, so an exception raised here stopped
 * that pass in the middle and left it stopped: statuses, liveness and the attention queue
 * all froze for as long as the file sat there, while the log filled up every few seconds.
 */
test('a transcript that cannot be read is skipped rather than thrown out of, and is reported once', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aivis-transcripts-'))
  tempDirs.push(dir)
  // Two ways a transcript refuses to be read. A directory in a file's place opens and then
  // fails on the read whoever runs the suite; a mode-000 file fails on the open, unless the
  // suite is running as root, which can read it anyway.
  const directory = path.join(dir, 'b8e04d71-0000-4000-8000-000000000002.jsonl')
  await fs.mkdir(directory)
  const unopenable = path.join(dir, 'b8e04d71-0000-4000-8000-000000000003.jsonl')
  await fs.writeFile(unopenable, asJsonl([userPrompt('Trace the double charge.', { at: ago(60_000) })]))
  await fs.chmod(unopenable, 0o000)

  const index = new TranscriptIndex()
  const logged = await captureErrors(async () => {
    assert.equal(await index.ingest(directory), null)
    assert.equal(await index.ingest(directory), null, 'and again on the pass after that')
    if (process.getuid?.() !== 0) assert.equal(await index.ingest(unopenable), null)
  })
  assert.equal(logged.filter((line) => line.includes(directory)).length, 1, 'said once, not every 400ms')

  // The scan carries on: the file after the bad one is read as if it had never been there.
  const good = await newTranscript(asJsonl([userPrompt('The next file in the pass.', { at: ago(60_000) })]))
  assert.equal((await index.ingest(good))?.userTurns, 1)
  await fs.chmod(unopenable, 0o600)
})

/*
 * Skipping a file is about this pass, not about the session. Returning nothing for a file
 * that read normally a moment ago tells the fleet the session has gone: it broadcasts a
 * removal, the web client drops it, and the page open on it unmounts — taking the composer's
 * contents and the scroll position with it — only for the session to reappear on the next
 * pass. One EMFILE burst does that to every session at once.
 */
test('a file that stops being readable keeps the session it already read, and picks up the rest later', async () => {
  // Root can open a mode-000 file, so there is no way to make the read fail for it.
  if (process.getuid?.() === 0) return

  const file = await newTranscript(asJsonl([userPrompt('Trace the double charge.', { at: ago(120_000) })]))
  const index = new TranscriptIndex()
  assert.equal((await index.ingest(file))?.userTurns, 1)

  // Something is appended, so the next pass has bytes to read, and then the file stops
  // being openable — a permission change, a mount going away, the process out of handles.
  await fs.appendFile(file, asJsonl([userPrompt('And the refund path.', { at: ago(60_000) })]))
  await fs.chmod(file, 0o000)
  const logged = await captureErrors(async () => {
    const stale = await index.ingest(file)
    assert.ok(stale, 'the session stays in the fleet rather than being removed from under the open page')
    assert.equal(stale.userTurns, 1, 'it shows what was last readable; the unread bytes are simply not there yet')
  })
  assert.equal(logged.length, 1, 'and the failure is still reported, once')

  await fs.chmod(file, 0o600)
  const recovered = await index.ingest(file)
  assert.equal(recovered?.userTurns, 2, 'the offset did not move, so the failed pass lost nothing')
})

test('a transcript that shrank is parsed again from the start rather than continued from a stale offset', async () => {
  const file = await newTranscript(
    asJsonl([
      userPrompt('First prompt.', { at: ago(180_000) }),
      userPrompt('Second prompt.', { at: ago(120_000) }),
      userPrompt('Third prompt.', { at: ago(60_000) }),
    ]),
  )
  const index = new TranscriptIndex()
  const before = await index.ingest(file)
  assert.equal(before?.userTurns, 3)

  await fs.writeFile(file, asJsonl([userPrompt('Rewritten prompt.', { at: ago(30_000) })]))
  const after_ = await index.ingest(file)
  assert.equal(after_?.userTurns, 1, 'the old accumulator is discarded rather than added to')
  assert.equal(after_?.title, 'Rewritten prompt.')
})

test('a file with nothing timestamped in it yields no session, and a file that is gone is forgotten', async () => {
  const index = new TranscriptIndex()

  // A lone summary carries no timestamp, so there is no activity to place a session by.
  const summaryOnly = await newTranscript(asJsonl([summaryRecord('Load test harness')]))
  assert.equal(await index.ingest(summaryOnly), null)

  const missing = path.join(os.tmpdir(), 'aivis-transcripts-missing', 'nope.jsonl')
  assert.equal(await index.ingest(missing), null)
})

test('an oversized transcript is read at both ends, and forgets a question the skipped middle could have answered', async () => {
  const opening = 'The tier resolver double-charges when a plan changes mid-cycle.'
  const rows: unknown[] = [
    userPrompt(opening, { at: ago(3 * 3600_000) }),
    assistant([askBlock('toolu-ask-head', [{ question: 'Move it or flag it?', header: 'Fix shape' }])], {
      at: ago(3 * 3600_000),
    }),
  ]
  // Filler large enough that the head window, the tail window and a real gap between them
  // all exist: roughly 1.2 MB of records, read with a 700 KB ceiling.
  const filler = 'x'.repeat(900)
  for (let i = 0; i < 1_300; i += 1) {
    rows.push(assistant([toolUse(`toolu-fill-${i}`, 'Bash', { command: filler })], { at: ago(2 * 3600_000) }))
  }
  rows.push(assistant([text('Done.')], { at: ago(60_000), stopReason: 'end_turn' }))

  const body = asJsonl(rows)
  assert.ok(body.length > 1_100_000, 'the fixture has to be big enough to be sampled')
  const file = await newTranscript(body)

  const index = new TranscriptIndex()
  const acc = await index.ingest(file, 700 * 1024)
  assert.ok(acc)
  assert.equal(index.isSampled(file), true)
  // The head supplies the opening prompt; the tail supplies current status.
  assert.equal(acc.title, opening)
  assert.equal(acc.lastShape, 'assistant-end')
  assert.equal(display(acc, ALIVE).status, 'idle')
  // Counts become lower bounds, because the middle was never read.
  assert.ok(acc.assistantTurns < 1_302, 'the skipped middle is missing from the counts')
  assert.ok(acc.assistantTurns > 0)
  // The question in the head is exactly the thing the skipped middle could have settled,
  // so it is dropped rather than reported as still open.
  assert.equal(acc.ask, null)

  // The read offset is left at the end of the file, so a live session is exact from here on:
  // the append lands on top of the sampled state and is parsed once, rather than restarting
  // the sample or being skipped as part of the middle.
  const sampledUserTurns = acc.userTurns
  const sampledAssistantTurns = acc.assistantTurns
  await fs.appendFile(file, asJsonl([userPrompt('And now the legacy path.', { at: ago(1_000) })]))
  const after_ = await index.ingest(file, 700 * 1024)
  assert.equal(after_?.userTurns, sampledUserTurns + 1)
  assert.equal(after_?.assistantTurns, sampledAssistantTurns, 'nothing already read is read again')
  assert.equal(after_?.lastShape, 'user-prompt')
})

/**
 * `AIVIS_FULL_PARSE_MAX_MB` can be set below the 512 KB the sampling window is fixed at. A
 * file between the two sizes is then sampled although the head already read it whole, and
 * the tail length goes negative. That threw out of `sampleLargeFile`, and neither `ingest`
 * nor `FleetIndex.refresh` catches it, so one such file failed the entire fleet scan.
 */
test('a transcript sampled under a ceiling smaller than the head window is still read rather than throwing', async () => {
  const file = await newTranscript(asJsonl([userPrompt('Small but over a tiny ceiling.', { at: ago(60_000) })]))
  const index = new TranscriptIndex()
  const acc = await index.ingest(file, 100)
  assert.ok(acc)
})

/**
 * Effort is not taken from a subagent, because a subagent runs at a lower one and reading
 * it back would report the session as having dropped. The model on the same record needs
 * the same guard for the same reason: subagents routinely run a smaller model, and without
 * it a session showed whatever its last agent ran as its own.
 */
test('a subagent running a smaller model does not report the session as having changed model', async () => {
  const acc = await fold([
    assistant([toolUse('toolu-task-3', 'Task', { description: 'Review pricing' })], {
      at: ago(120_000),
      model: 'claude-opus-5',
      effort: 'high',
    }),
    assistant([text('Reading.')], { at: ago(60_000), model: 'claude-haiku-4-5', sidechain: true }),
  ])

  assert.equal(acc.model, 'claude-opus-5')
})

// --- What the session is reported to be doing --------------------------------------------

test('the last tool call of a turn is what the session reports doing, described by the field that tool carries', async () => {
  // Each tool keeps its meaning in a different input field, and the index draws one line
  // from it. Reading the wrong field leaves the row blank or, worse, shows a plausible
  // string from an unrelated argument.
  const acc = await fold([
    userPrompt('Run the ledger tests.', { at: ago(120_000) }),
    assistant(
      [
        toolUse('toolu-read-5', 'Read', { file_path: `${CWD}/app/ledger/post.py` }),
        toolUse('toolu-bash-4', 'Bash', { command: 'pytest -q tests/test_ledger.py' }),
      ],
      { at: ago(60_000) },
    ),
  ])

  assert.equal(acc.lastActivity?.tool, 'Bash', 'the last call of the turn, not the first')
  assert.equal(acc.lastActivity?.detail, 'pytest -q tests/test_ledger.py')
})

test('a file path inside the session directory is shown relative to it, and one outside it whole', async () => {
  // The rail has room for a path, not for a path plus the checkout it sits in, and the
  // checkout is the same for every row anyway.
  const inside = await fold([
    assistant([toolUse('toolu-read-6', 'Read', { file_path: `${CWD}/app/ledger/post.py` })], { at: ago(60_000) }),
  ])
  assert.equal(inside.lastActivity?.detail, 'app/ledger/post.py')

  const outside = await fold([
    assistant([toolUse('toolu-read-7', 'Read', { file_path: '/etc/hosts' })], { at: ago(60_000) }),
  ])
  assert.equal(outside.lastActivity?.detail, '/etc/hosts', 'nothing to strip, so nothing is stripped')

  // A path that merely starts with the same characters is not inside the directory.
  const neighbour = await fold([
    assistant([toolUse('toolu-read-8', 'Read', { file_path: `${CWD}-old/app/ledger/post.py` })], {
      at: ago(60_000),
    }),
  ])
  assert.equal(neighbour.lastActivity?.detail, `${CWD}-old/app/ledger/post.py`)
})

test('a description too long for the row is cut, and a tool the index does not know still says something', async () => {
  const long = await fold([
    assistant([toolUse('toolu-bash-5', 'Bash', { command: `echo ${'x'.repeat(200)}` })], { at: ago(60_000) }),
  ])
  assert.equal(long.lastActivity?.detail.length, 90, 'the row is 90 characters wide')
  assert.ok(long.lastActivity?.detail.endsWith('…'))

  // Nothing in `describeTool` knows this tool, so it falls back to the first string input
  // rather than leaving the row empty.
  const unknown = await fold([
    assistant([toolUse('toolu-plan-1', 'ExitPlanMode', { plan: 'Move proration out of ledger.post().' })], {
      at: ago(60_000),
    }),
  ])
  assert.equal(unknown.lastActivity?.detail, 'Move proration out of ledger.post().')
})

test('tool activity is bucketed by the minute it happened in, and the sparkline ends at now', async () => {
  const acc = await fold([
    assistant([toolUse('toolu-pulse-1', 'Bash', { command: 'a' }), toolUse('toolu-pulse-2', 'Bash', { command: 'b' })], {
      at: ago(0),
    }),
    // Forty minutes ago is outside the window the sparkline draws, so it contributes
    // nothing however much of it there was.
    assistant([toolUse('toolu-pulse-3', 'Grep', { pattern: 'apply_proration' })], { at: ago(40 * 60_000) }),
  ])

  const pulse = display(acc, ALIVE).pulse
  assert.equal(pulse.length, 15, 'fifteen minutes, one bar each')
  // The bars run oldest to newest, so this turn's two calls are at the right-hand end. The
  // two rightmost bars are read together because the minute can tick between the two lines
  // above and this one. Drawn newest-first they would be at the left-hand end instead.
  assert.equal((pulse[14] ?? 0) + (pulse[13] ?? 0), 2)
  assert.equal(pulse.slice(0, 13).reduce((sum, bar) => sum + bar, 0), 0)
})

test('a transcript that never named its session or directory is placed by its own path', async () => {
  // Records written before the first one carrying `sessionId` and `cwd` still have to land
  // in a project on the index, and the file itself is the only thing left to go on.
  const acc = await fold([
    { type: 'user', timestamp: ago(60_000), message: { role: 'user', content: [text('Start here.')] } },
  ])
  assert.equal(acc.sessionId, null)
  assert.equal(acc.cwd, null)

  const session = display(acc)
  assert.equal(session.id, 'sess-abc', 'the transcript filename is the session id')
  assert.equal(session.cwd, CWD)
  assert.equal(session.projectName, 'checkout-api')
})

/*
 * The id is spent on a command line: 'copy resume' hands you `claude --resume <id>` to paste
 * into a terminal. Nothing stops another local process — or the model's own Write tool —
 * from dropping a transcript into the store that calls itself whatever it likes, so a file
 * whose id is not one is refused a session here, rather than left for every later place
 * that spends the id to quote it correctly.
 */
test('a transcript naming its session something that is not a session id yields no session at all', async () => {
  const injected = 'abc; touch /tmp/aivis-never-run #'
  const declared = await newTranscript(
    asJsonl([{ ...userPrompt('Trace the double charge.', { at: ago(60_000) }), sessionId: injected }]),
  )
  const named = await newTranscript(
    // Records with no `sessionId` of their own, so the file's name is the other place the
    // id would be taken from.
    asJsonl([{ type: 'user', timestamp: ago(60_000), message: { role: 'user', content: [text('Start here.')] } }]),
    // A file name cannot carry a slash, so this one does its damage in whatever directory
    // the paste lands in. It is a name on disk and nothing here ever runs it.
    'abc; touch pwned #.jsonl',
  )

  const index = new TranscriptIndex()
  await captureErrors(async () => {
    assert.equal(await index.ingest(declared), null, 'the id its records claim is not one')
    assert.equal(await index.ingest(named), null, 'and neither is the name it was filed under')
  })

  assert.equal(isPlausibleSessionId('b8e04d71-0000-4000-8000-000000000001'), true)
  assert.equal(isPlausibleSessionId('sess-abc'), true)
  // A leading dash would reach `claude --resume` as a flag rather than as an id, and a
  // newline ends one command line and starts another.
  assert.equal(isPlausibleSessionId('--dangerously-skip-permissions'), false)
  assert.equal(isPlausibleSessionId('abc\ntouch /tmp/aivis-never-run'), false)
  assert.equal(isPlausibleSessionId(''), false)
})

// --- Background tasks -------------------------------------------------------------------

/** The notice Claude Code files when work started outside the turn has finished. */
const taskNotice = (toolUseId: string, status = 'completed', at = ago(0)) =>
  userPrompt(
    `<task-notification>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n</task-notification>`,
    { at },
  )

test('work handed off to run outside the turn is reported while the session is alive', async () => {
  const acc = await fold([
    userPrompt('audit the pricing docs'),
    assistant([toolUse('toolu_wf', 'Workflow', { description: 'doc audit' })]),
  ])
  const session = display(acc, { livePids: [4242] })
  assert.equal(session.background.length, 1)
  assert.equal(session.background[0]?.tool, 'Workflow')
  assert.equal(session.background[0]?.toolUseId, 'toolu_wf')
})

test('the notice closes the task it names and leaves any other still running', async () => {
  const acc = await fold([
    userPrompt('do two things at once'),
    assistant([toolUse('toolu_a', 'Workflow', {}), toolUse('toolu_b', 'Agent', {})]),
    taskNotice('toolu_a'),
  ])
  const session = display(acc, { livePids: [4242] })
  assert.deepEqual(
    session.background.map((task) => task.toolUseId),
    ['toolu_b'],
    'only the task the notice named is closed',
  )
})

/*
 * The notice is filed as a user record wrapped in a tag, so it is dropped as Claude Code's
 * own bookkeeping. It has to be read before that happens or nothing ever closes a task.
 */
test('the notice still closes its task although it is filtered out of the conversation', async () => {
  const acc = await fold([
    userPrompt('start it'),
    assistant([toolUse('toolu_wf', 'Workflow', {})]),
    taskNotice('toolu_wf'),
  ])
  assert.equal(acc.userTurns, 1, 'the notice is not counted as a turn')
  assert.equal(display(acc, { livePids: [4242] }).background.length, 0, 'but it did close the task')
})

test('a notice pushed in over the session socket closes its task too, which is the other way it arrives', async () => {
  const acc = await fold([
    userPrompt('start it'),
    assistant([toolUse('toolu_wf', 'Workflow', {})]),
    queuedCommand('<task-notification>\n<tool-use-id>toolu_wf</tool-use-id>\n<status>stopped</status>\n</task-notification>'),
  ])
  assert.equal(display(acc, { livePids: [4242] }).background.length, 0)
})

test('a session with no process reports nothing running, because nothing can be', async () => {
  const acc = await fold([
    userPrompt('start it'),
    assistant([toolUse('toolu_wf', 'Workflow', {})]),
  ])
  assert.equal(display(acc, { livePids: [] }).background.length, 0)
  assert.equal(display(acc, { livePids: [4242] }).background.length, 1, 'and one with a process does')
})

/*
 * The bound that keeps this honest. A notice is not guaranteed — a session killed mid-task
 * never writes one — and on a real store this window turned 25 tasks that had been "running"
 * for up to eight days into nothing.
 */
test('a task older than the window is dropped, since its notice is never coming', async () => {
  const acc = await fold([
    userPrompt('start it'),
    assistant([toolUse('toolu_wf', 'Workflow', {})], { at: ago(9 * 3600_000) }),
  ])
  assert.equal(display(acc, { livePids: [4242], taskWindowMs: 6 * 3600_000 }).background.length, 0)
  assert.equal(
    display(acc, { livePids: [4242], taskWindowMs: 12 * 3600_000 }).background.length,
    1,
    'and is reported again when the window is widened past it',
  )
})

test('an ordinary foreground tool call is not mistaken for background work', async () => {
  const acc = await fold([
    userPrompt('read a file'),
    assistant([toolUse('toolu_r', 'Read', { file_path: '/tmp/x.ts' }), toolUse('toolu_b', 'Bash', { command: 'ls' })]),
  ])
  assert.equal(display(acc, { livePids: [4242] }).background.length, 0)
})

test('a backgrounded Bash call is reported, and carries what it is running', async () => {
  const acc = await fold([
    userPrompt('kick off the suite'),
    assistant([toolUse('toolu_b', 'Bash', { command: 'npm test -- --watch', run_in_background: true })]),
  ])
  const session = display(acc, { livePids: [4242] })
  assert.equal(session.background.length, 1)
  assert.equal(session.background[0]?.tool, 'Bash')
  assert.match(session.background[0]?.detail ?? '', /npm test/)
})

/*
 * `!` bash lines reach the conversation two ways, and the reader has to know both.
 *
 * A terminal writes the command and its output as two records; aivis cannot write to a
 * transcript at all, so it puts both halves in the text of the message it sends and the
 * record that results starts with a tag while still carrying a real prompt. Both are marked
 * synthetic by `isSynthetic` — correctly, neither is a prompt — and the reader has to take
 * them before that filter does, or a run started from the browser leaves no trace on the page
 * that started it and the message sent with it disappears along with it.
 */
test('a `!` line written by a terminal is read as one run across its two records', async () => {
  const file = await newTranscript(
    asJsonl([
      userPrompt('<bash-input>gcloud config set project acme</bash-input>', { at: ago(120_000) }),
      userPrompt(
        '<bash-stdout>Updated property [core/project].</bash-stdout><bash-stderr></bash-stderr>',
        { at: ago(119_000) },
      ),
      userPrompt('which project am I on?', { at: ago(60_000) }),
    ]),
  )

  const page = await readTranscript(file, 'sess-bash', 500)
  const runs = page.entries.filter((entry) => entry.kind === 'bash')
  assert.equal(runs.length, 1, 'the output record folds onto the command rather than becoming its own run')
  assert.equal(runs[0]?.kind === 'bash' ? runs[0].command : null, 'gcloud config set project acme')
  assert.equal(runs[0]?.kind === 'bash' ? runs[0].stdout : null, 'Updated property [core/project].')

  const prompts = page.entries.filter((entry) => entry.kind === 'user')
  assert.equal(prompts.length, 1, 'a run is not a prompt, and the real prompt is still one')
})

test('a run aivis sent in front of a message keeps both the run and the message', async () => {
  const file = await newTranscript(
    asJsonl([
      userPrompt(
        '<bash-input>npm test</bash-input>\n' +
          '<bash-stdout>1 failing</bash-stdout><bash-stderr>[aivis] exit status 1</bash-stderr>\n\n' +
          'fix it',
        { at: ago(60_000) },
      ),
    ]),
  )

  const page = await readTranscript(file, 'sess-bash2', 500)
  const run = page.entries.find((entry) => entry.kind === 'bash')
  assert.equal(run?.kind === 'bash' ? run.command : null, 'npm test')
  assert.equal(run?.kind === 'bash' ? run.stderr : null, '[aivis] exit status 1')

  // The part the synthetic filter used to swallow whole: the record opens with a tag, so
  // everything in it looked like machinery, including the thing the user actually typed.
  const prompt = page.entries.find((entry) => entry.kind === 'user')
  assert.equal(prompt?.kind === 'user' ? prompt.text : null, 'fix it')
})
