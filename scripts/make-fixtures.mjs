/**
 * Write an invented fleet into `fixtures/projects`, for `npm run demo`.
 *
 * aivis reads `~/.claude/projects`, so running it normally puts every prompt you have ever
 * typed on screen — your own work and anyone else's. That is fine when you are using it and
 * a problem when you are developing it, taking a screenshot, or attaching a repro to a
 * public issue. Pointing `AIVIS_PROJECTS_DIR` at this store gives a fleet with the same
 * shape and none of the content.
 *
 * The store is generated rather than committed because status and ordering are computed
 * from timestamps: a file checked in last year would render as a fleet that has been
 * asleep since. Every session here is stamped relative to the moment you run this, so the
 * demo always looks like a machine somebody is working on.
 *
 * The fleet is deliberately varied — a session holding a question, one that finished its
 * turn and is waiting, one that stopped mid-tool-call, one long-running, one barely
 * started — because those are the states the index is built to tell apart. Note that none
 * of them can report as `working`: that requires a live `claude` process, and these are
 * files with nothing behind them.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'fixtures', 'projects')

const VERSION = '2.0.0'
const MODEL = 'claude-opus-5'
const HOME = '/home/dev'

const now = Date.now()
/** A timestamp `minutes` ago, in the ISO form Claude Code writes. */
const ago = (minutes) => new Date(now - minutes * 60_000).toISOString()

/** Claude Code's directory name for a working directory: every non-alphanumeric run becomes a dash. */
const slugOf = (cwd) => cwd.replace(/[^a-zA-Z0-9]+/g, '-')

let uuidCounter = 0
/** Deterministic ids, so a regenerated store does not look like a different fleet. */
function id(prefix) {
  const n = (uuidCounter += 1).toString(16).padStart(12, '0')
  return `${prefix}-0000-4000-8000-${n}`
}

/** The record shapes `server/transcripts.ts` reads, in the order a real session writes them. */
function makeSession({ sessionId, cwd, branch, minutesAgo, prompt, turns, tail }) {
  const rows = []
  let at = minutesAgo
  const base = { sessionId, cwd, gitBranch: branch, version: VERSION, permissionMode: 'auto' }

  const step = (extra) => {
    rows.push({ ...base, timestamp: ago(at), ...extra })
    at = Math.max(0, at - Math.max(1, Math.round(minutesAgo / (turns.length * 3 + 4))))
  }

  step({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } })

  for (const turn of turns) {
    const toolUseId = id('toolu')
    step({
      type: 'assistant',
      effort: 'high',
      message: {
        role: 'assistant',
        model: MODEL,
        content: [
          { type: 'text', text: turn.say },
          { type: 'tool_use', id: toolUseId, name: turn.tool, input: turn.input },
        ],
        usage: {
          input_tokens: 240,
          output_tokens: 620,
          cache_read_input_tokens: turn.cacheRead ?? 48_000,
          cache_creation_input_tokens: 1_800,
        },
      },
    })
    step({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: turn.result }] },
    })
  }

  // How the session was left is the whole point of each fixture, so the tail is explicit
  // rather than implied by whatever the last turn happened to be.
  if (tail.kind === 'asking') {
    step({
      type: 'assistant',
      effort: 'high',
      message: {
        role: 'assistant',
        model: MODEL,
        content: [
          { type: 'text', text: tail.say },
          { type: 'tool_use', id: id('toolu'), name: 'AskUserQuestion', input: { questions: tail.questions } },
        ],
        usage: { input_tokens: 190, output_tokens: 310, cache_read_input_tokens: 52_000, cache_creation_input_tokens: 900 },
      },
    })
  } else if (tail.kind === 'finished') {
    step({
      type: 'assistant',
      effort: 'high',
      message: {
        role: 'assistant',
        model: MODEL,
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: tail.say }],
        usage: { input_tokens: 210, output_tokens: 940, cache_read_input_tokens: 61_000, cache_creation_input_tokens: 1_100 },
      },
    })
  } else if (tail.kind === 'mid-tool') {
    // No tool_result follows, which is what a session that stopped inside a long command
    // looks like from the outside — and what aivis reports as stalled.
    step({
      type: 'assistant',
      effort: 'high',
      message: {
        role: 'assistant',
        model: MODEL,
        content: [
          { type: 'text', text: tail.say },
          { type: 'tool_use', id: id('toolu'), name: tail.tool, input: tail.input },
        ],
        usage: { input_tokens: 180, output_tokens: 260, cache_read_input_tokens: 44_000, cache_creation_input_tokens: 700 },
      },
    })
  }

  if (tail.summary) rows.push({ type: 'summary', summary: tail.summary, sessionId })
  return rows
}

const SESSIONS = [
  {
    sessionId: id('3f1c8a20'),
    cwd: `${HOME}/code/acme/checkout-api`,
    branch: 'pricing-tiers',
    minutesAgo: 74,
    prompt:
      'The tier resolver double-charges when a plan changes mid-cycle. Trace it from the webhook down to the ledger write and tell me where the proration is applied twice.',
    turns: [
      {
        say: 'Starting from the webhook handler so I can follow one change through the whole path.',
        tool: 'Read',
        input: { file_path: `${HOME}/code/acme/checkout-api/app/pricing/tier_resolver.py` },
        result: '412 lines. resolve_tier() calls apply_proration() and then hands the result to ledger.post().',
      },
      {
        say: 'ledger.post() may be prorating again. Checking every caller before I assume that.',
        tool: 'Grep',
        input: { pattern: 'apply_proration', path: `${HOME}/code/acme/checkout-api/app` },
        result: 'app/pricing/tier_resolver.py:188\napp/pricing/legacy_pricing.py:64\napp/ledger/post.py:203',
      },
      {
        say: 'Three call sites, and post.py is downstream of the other two. That is the double.',
        tool: 'Read',
        input: { file_path: `${HOME}/code/acme/checkout-api/app/ledger/post.py` },
        result: '244 lines. Line 203 prorates unconditionally, including for amounts that arrive already prorated.',
      },
    ],
    tail: {
      kind: 'asking',
      say: 'I can fix this in two places and they behave differently for the legacy path.',
      questions: [
        {
          question:
            'Should proration move out of ledger.post() entirely, or stay there with tier_resolver passing a flag saying the amount is already prorated?',
          header: 'Fix shape',
          options: [
            { label: 'Move it out of post()', description: 'One owner for proration. Touches the legacy path, which has no tests.' },
            { label: 'Pass a flag', description: 'Smaller diff and leaves legacy alone, but keeps two places that know about proration.' },
          ],
          multiSelect: false,
        },
      ],
      summary: 'Tracing a double-charge in the tier resolver',
    },
  },
  {
    sessionId: id('b8e04d71'),
    cwd: `${HOME}/code/acme/checkout-web`,
    branch: 'checkout-retry',
    minutesAgo: 26,
    prompt: 'Add a retry affordance to the payment step when the gateway times out, and make sure it cannot double-submit.',
    turns: [
      {
        say: 'Reading the payment step to see how submission state is currently held.',
        tool: 'Read',
        input: { file_path: `${HOME}/code/acme/checkout-web/src/checkout/PaymentStep.tsx` },
        result: '318 lines. Submission is a boolean, reset in a finally block, so a timeout leaves it false while the request is still in flight.',
      },
      {
        say: 'Replacing the boolean with an explicit state and adding the retry button behind it.',
        tool: 'Edit',
        input: { file_path: `${HOME}/code/acme/checkout-web/src/checkout/PaymentStep.tsx` },
        result: 'Applied. 34 insertions, 11 deletions.',
      },
      {
        say: 'Running the checkout suite.',
        tool: 'Bash',
        input: { command: 'npm test -- src/checkout', description: 'Run the checkout tests' },
        result: '24 passing, 0 failing.',
      },
    ],
    tail: {
      kind: 'finished',
      say: 'Done. `PaymentStep` now holds an explicit `idle | submitting | timed-out | failed` state instead of a boolean, and the retry button only renders in `timed-out`. The double-submit came from resetting the flag in `finally` while the request was still outstanding, so the reset now happens on the response rather than on the way out of the handler. 24 tests pass.',
      summary: 'Retry affordance for payment timeouts',
    },
  },
  {
    sessionId: id('c47a9e63'),
    cwd: `${HOME}/code/acme/pricing-engine`,
    branch: 'main',
    minutesAgo: 9,
    prompt: 'Backfill tier ids for the accounts the rule gate skipped last month. Dry run first, and tell me how many rows it would touch before you change anything.',
    turns: [
      {
        say: 'Finding the rows the gate skipped.',
        tool: 'Bash',
        input: { command: 'python -m tools.backfill --dry-run --since 2026-07-01', description: 'Dry-run the tier backfill' },
        result: 'Would update 1,412 rows across 906 accounts. No rows would be deleted.',
      },
    ],
    tail: {
      kind: 'mid-tool',
      say: 'That is the scope. Verifying none of those accounts were re-tiered by hand in the meantime before I write anything.',
      tool: 'Bash',
      input: { command: 'python -m tools.backfill --verify --since 2026-07-01', description: 'Check for manual re-tiering' },
      summary: 'Backfilling tier ids the rule gate skipped',
    },
  },
  {
    sessionId: id('d2b7f095'),
    cwd: `${HOME}/code/acme/docs-site`,
    branch: 'main',
    minutesAgo: 310,
    prompt: 'The pricing docs still describe the old two-tier model. Go through docs/pricing and bring every page in line with what the code actually does now.',
    turns: [
      {
        say: 'Listing the pricing pages so I can work through them in order.',
        tool: 'Glob',
        input: { pattern: 'docs/pricing/**/*.md' },
        result: 'docs/pricing/index.md\ndocs/pricing/tiers.md\ndocs/pricing/proration.md\ndocs/pricing/migrating.md',
      },
      {
        say: 'tiers.md is the one the others link to, so it goes first.',
        tool: 'Edit',
        input: { file_path: `${HOME}/code/acme/docs-site/docs/pricing/tiers.md` },
        result: 'Applied. 61 insertions, 48 deletions.',
      },
      {
        say: 'Now the three pages that referred to the two-tier split.',
        tool: 'Edit',
        input: { file_path: `${HOME}/code/acme/docs-site/docs/pricing/proration.md` },
        result: 'Applied. 22 insertions, 19 deletions.',
      },
    ],
    tail: {
      kind: 'finished',
      say: 'All four pages now describe the four-tier model. The one thing I did not change is the worked example in `migrating.md`: it uses figures from the old model throughout, and rewriting it properly needs a decision about whether to keep a migration guide for a model nobody is on any more. Flagging rather than guessing.',
      summary: 'Updating the pricing docs to the four-tier model',
    },
  },
  {
    sessionId: id('e91d3c48'),
    cwd: `${HOME}/code/acme/checkout-api`,
    branch: 'main',
    minutesAgo: 2_600,
    prompt: 'Set up the load test harness for the quote endpoint so we can see where it falls over.',
    turns: [
      {
        say: 'Checking what is already here before adding anything.',
        tool: 'Bash',
        input: { command: 'ls tests/load', description: 'Look for an existing harness' },
        result: 'No such file or directory.',
      },
    ],
    tail: {
      kind: 'finished',
      say: 'Harness is in `tests/load/quote.py`, driven by locust. At 200 concurrent users `/v1/quote` holds p95 under 180ms; past 400 it degrades sharply and the connection pool is the limit rather than CPU.',
      summary: 'Load test harness for the quote endpoint',
    },
  },
]

async function main() {
  await fs.rm(outDir, { recursive: true, force: true })

  let files = 0
  for (const spec of SESSIONS) {
    const dir = path.join(outDir, slugOf(spec.cwd))
    await fs.mkdir(dir, { recursive: true })
    const rows = makeSession(spec)
    const body = rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
    await fs.writeFile(path.join(dir, `${spec.sessionId}.jsonl`), body)
    files += 1
    console.log(`  ${spec.sessionId}  ${String(rows.length).padStart(3)} records  ${spec.cwd}`)
  }

  console.log(`\nwrote ${files} fixture transcripts into fixtures/projects`)
  console.log('run them with:  npm run demo')
}

await main()
