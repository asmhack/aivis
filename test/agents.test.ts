/**
 * What `server/agents.ts` can say about a workflow run while it is still going.
 *
 * A run writes its JSON file when it ends, so everything the rail draws about a finished
 * run — the label and phase of each agent, the totals, the elapsed time — arrives only
 * after there is nothing left to watch. Until then the run has a working directory instead:
 * a journal naming every agent it started and every one that came back, and a transcript
 * per agent saying what that agent is doing right now. These assertions state what is
 * recoverable from that, and what honestly is not.
 *
 * The fixtures mirror the layout Claude Code writes: the run's agents under
 * `<session>/subagents/workflows/<runId>/`, the script it is running under
 * `<session>/workflows/scripts/`, and the finished run's own file under
 * `<session>/workflows/`.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listWorkflows, parentReader } from '../server/agents.ts'

const tempDirs: string[] = []

after(async () => {
  for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true })
})

const SESSION = 'b8e04d71-0000-4000-8000-000000000001'
const RUN = 'wf_abc123'
const ALIVE = { parentAlive: true, staleAfterMs: 120_000 }
const GONE = { parentAlive: false, staleAfterMs: 120_000 }

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

/** One assistant turn, carrying a tool call and the usage the turn reported. */
function turn(at: string, tool: string, detail: string, context: number): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: at,
    message: {
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'tool_use', id: `t-${at}`, name: tool, input: { command: detail } }],
      usage: {
        input_tokens: 4,
        output_tokens: 500,
        cache_read_input_tokens: context - 4,
        cache_creation_input_tokens: 0,
      },
    },
  })
}

function agentFile(prompt: string, turns: string[]): string {
  const opening = JSON.stringify({
    type: 'user',
    timestamp: ago(10 * 60_000),
    message: { role: 'user', content: prompt },
  })
  return [opening, ...turns].join('\n') + '\n'
}

/** The `Workflow` call that launched the run, as the parent transcript records it. */
const LAUNCH_CALL = 'toolu_01LaunchedTheRun'

/**
 * A parent transcript holding one `Workflow` call and the result that names the run.
 *
 * The result is the only thing tying a run id to the call that started it, which is what
 * lets the session say whether the run is over: a call with no completion notice is a run
 * that has not ended.
 */
function parentTranscript(): string {
  const at = ago(20 * 60_000)
  return (
    [
      JSON.stringify({
        type: 'assistant',
        uuid: 'u1',
        timestamp: at,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: LAUNCH_CALL, name: 'Workflow', input: { script: '…' } }],
        },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'u2',
        timestamp: at,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: LAUNCH_CALL,
              content: `Workflow launched in background.\nRun ID: ${RUN}\n`,
            },
          ],
        },
      }),
    ].join('\n') + '\n'
  )
}

interface RunFixture {
  /** Agent id to the transcript body written for it. */
  agents: Record<string, string>
  /** Agent ids the journal says were started, in order. */
  started: string[]
  /** Agent ids the journal says came back, with what they returned. */
  results?: Record<string, unknown>
  /** Script written beside the run, or none at all. */
  script?: { name: string; body: string }
  /** A finished run's own JSON file, for the case where one has been filed. */
  filed?: Record<string, unknown>
  /** Write a parent transcript recording the call that launched the run. */
  launched?: boolean
}

/** Lay out a session directory holding one run, and return the transcript path. */
async function store(fixture: RunFixture): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aivis-agents-'))
  tempDirs.push(root)
  const transcript = path.join(root, `${SESSION}.jsonl`)
  await fs.writeFile(transcript, fixture.launched ? parentTranscript() : '')

  const runDir = path.join(root, SESSION, 'subagents', 'workflows', RUN)
  await fs.mkdir(runDir, { recursive: true })
  for (const [agentId, body] of Object.entries(fixture.agents)) {
    await fs.writeFile(path.join(runDir, `agent-${agentId}.jsonl`), body)
  }
  const journal = [
    ...fixture.started.map((agentId) => JSON.stringify({ type: 'started', key: `v2:${agentId}`, agentId })),
    ...Object.entries(fixture.results ?? {}).map(([agentId, result]) =>
      JSON.stringify({ type: 'result', key: `v2:${agentId}`, agentId, result }),
    ),
  ]
  await fs.writeFile(path.join(runDir, 'journal.jsonl'), journal.join('\n') + '\n')

  if (fixture.script) {
    const scripts = path.join(root, SESSION, 'workflows', 'scripts')
    await fs.mkdir(scripts, { recursive: true })
    await fs.writeFile(path.join(scripts, `${fixture.script.name}-${RUN}.js`), fixture.script.body)
  }
  if (fixture.filed) {
    const dir = path.join(root, SESSION, 'workflows')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, `${RUN}.json`), JSON.stringify(fixture.filed))
  }
  return transcript
}

const SCRIPT = {
  name: 'audit-fixes',
  body: [
    'export const meta = {',
    "  name: 'audit-fixes',",
    "  description: 'Fix every finding, then green the build',",
    "  phases: [{ title: 'Fix' }, { title: 'Integrate' }],",
    '}',
    'const RULES = `you own one file`',
  ].join('\n'),
}

test('a run with no file of its own is assembled from the directory it is filling', async () => {
  const transcript = await store({
    agents: {
      a1: agentFile('fix H-002', [turn(ago(9 * 60_000), 'Read', 'server/index.ts', 30_000)]),
      a2: agentFile('fix M-004', [
        turn(ago(60_000), 'Grep', 'liveProcesses', 40_000),
        turn(ago(5_000), 'Edit', 'server/fleet.ts', 52_000),
      ]),
    },
    started: ['a1', 'a2'],
    results: { a1: { status: 'fixed' } },
    script: SCRIPT,
  })

  const [run, ...rest] = await listWorkflows(transcript, ALIVE)
  assert.equal(rest.length, 0)
  assert.ok(run)
  assert.equal(run.live, true)
  assert.equal(run.runId, RUN)
  assert.equal(run.status, 'running')
  // Name and goal come from the script, which is the only place either is written down
  // until the run ends.
  assert.equal(run.name, 'audit-fixes')
  assert.equal(run.summary, 'Fix every finding, then green the build')
  assert.equal(run.agentCount, 2)

  // The journal's order is the run's own, and an agent it has heard back from is done
  // whatever its transcript looks like.
  assert.deepEqual(
    run.agents.map((agent) => [agent.label, agent.state]),
    [
      ['agent 1', 'done'],
      ['agent 2', 'running'],
    ],
  )
  const [first, second] = run.agents
  assert.equal(first?.resultPreview, '{"status":"fixed"}')
  assert.equal(second?.lastToolName, 'Edit')
  assert.equal(second?.lastToolSummary, 'server/fleet.ts')
  assert.equal(second?.promptPreview, 'fix M-004')
})

/*
 * The run's own accounting for an agent is the context it ended up holding, not the sum of
 * every turn's usage — that counts a cached prefix once per turn that read it and climbs to
 * several times anything real. Reading the same figure here is what keeps a run's totals
 * from collapsing the moment it files its JSON and the rail switches source.
 */
test('an agent reports the context it is holding rather than the sum of its turns', async () => {
  const transcript = await store({
    agents: {
      a1: agentFile('do it', [
        turn(ago(120_000), 'Read', 'one.ts', 30_000),
        turn(ago(60_000), 'Read', 'two.ts', 45_000),
        turn(ago(5_000), 'Read', 'three.ts', 61_000),
      ]),
    },
    started: ['a1'],
  })

  const [run] = await listWorkflows(transcript, ALIVE)
  assert.equal(run?.agents[0]?.tokens, 61_000)
  assert.equal(run?.totalTokens, 61_000)
  assert.equal(run?.agents[0]?.toolCalls, 3)
})

/*
 * A run whose session was killed leaves the same directory as one still going, and the file
 * that would have closed it is never coming. Reporting its agents as running would leave a
 * dead run advancing on the page for ever.
 */
test('a run whose session is gone reports itself stopped, and its agents cancelled', async () => {
  const transcript = await store({
    agents: {
      a1: agentFile('fix it', [turn(ago(9 * 60_000), 'Bash', 'npm test', 30_000)]),
      a2: agentFile('check it', [turn(ago(8 * 60_000), 'Bash', 'npm run build', 20_000)]),
    },
    started: ['a1', 'a2'],
    results: { a1: 'done' },
  })

  const [run] = await listWorkflows(transcript, GONE)
  assert.equal(run?.status, 'stopped')
  assert.deepEqual(run?.agents.map((agent) => agent.state), ['done', 'cancelled'])
})

test('a run that has filed its JSON is read from it, and its directory is not read twice', async () => {
  const transcript = await store({
    agents: { a1: agentFile('fix it', [turn(ago(60_000), 'Read', 'x.ts', 10_000)]) },
    started: ['a1'],
    script: SCRIPT,
    filed: {
      runId: RUN,
      workflowName: 'audit-fixes',
      status: 'completed',
      timestamp: ago(30 * 60_000),
      agentCount: 1,
      totalTokens: 12_345,
      phases: [{ title: 'Fix' }],
      workflowProgress: [
        {
          type: 'workflow_agent',
          index: 1,
          label: 'fix:index',
          phaseIndex: 1,
          phaseTitle: 'Fix',
          state: 'done',
          tokens: 12_345,
        },
      ],
    },
  })

  const runs = await listWorkflows(transcript, ALIVE)
  assert.equal(runs.length, 1)
  assert.equal(runs[0]?.live, false)
  // The filed run's own vocabulary, which the directory cannot reproduce.
  assert.equal(runs[0]?.agents[0]?.label, 'fix:index')
  assert.equal(runs[0]?.phases.length, 1)
})

test('a run with no script beside it falls back to its own id rather than inventing a name', async () => {
  const transcript = await store({
    agents: { a1: agentFile('fix it', [turn(ago(60_000), 'Read', 'x.ts', 10_000)]) },
    started: ['a1'],
  })

  const [run] = await listWorkflows(transcript, ALIVE)
  assert.equal(run?.name, RUN)
  assert.equal(run?.summary, null)
})

test('a script whose meta says nothing readable still names the run from its file name', async () => {
  const transcript = await store({
    agents: { a1: agentFile('fix it', [turn(ago(60_000), 'Read', 'x.ts', 10_000)]) },
    started: ['a1'],
    script: { name: 'nightly-sweep', body: 'const meta = buildMeta()\n' },
  })

  const [run] = await listWorkflows(transcript, ALIVE)
  assert.equal(run?.name, 'nightly-sweep')
  assert.equal(run?.summary, null)
})

test('an escaped quote in the script’s goal survives the read', async () => {
  const transcript = await store({
    agents: { a1: agentFile('fix it', [turn(ago(60_000), 'Read', 'x.ts', 10_000)]) },
    started: ['a1'],
    script: {
      name: 'quoted',
      body: "export const meta = {\n  name: 'quoted',\n  description: 'green the build, don\\'t break it',\n}\n",
    },
  })

  const [run] = await listWorkflows(transcript, ALIVE)
  assert.equal(run?.summary, "green the build, don't break it")
})

/*
 * The journal is written by the run rather than for this, so it can lag: an agent's
 * transcript exists before the line that says it started. Dropping it would take the newest
 * agent — the one you are watching — off the list.
 */
test('an agent whose transcript arrived before the journal caught up is still listed', async () => {
  const transcript = await store({
    agents: {
      a1: agentFile('first', [turn(ago(120_000), 'Read', 'x.ts', 10_000)]),
      a2: agentFile('second', [turn(ago(5_000), 'Read', 'y.ts', 12_000)]),
    },
    started: ['a1'],
  })

  const [run] = await listWorkflows(transcript, ALIVE)
  assert.equal(run?.agents.length, 2)
  assert.equal(run?.agentCount, 2)
  assert.equal(run?.agents[1]?.label, 'agent 2')
})

/*
 * The directory of a run killed an hour ago and one whose agents happen to be quiet between
 * phases are the same directory, and the session being alive says nothing either way — a
 * session resumed the next morning is alive again without yesterday's runs being. The one
 * thing that distinguishes them is the notice Claude Code files when the work ends, which
 * the session's own transcript either has or has not recorded yet.
 */
test('a run whose launching call is still outstanding is running, however quiet its agents are', async () => {
  const transcript = await store({
    agents: { a1: agentFile('fix it', [turn(ago(45 * 60_000), 'Bash', 'npm test', 30_000)]) },
    started: ['a1'],
    launched: true,
  })

  const [run] = await listWorkflows(
    transcript,
    { ...ALIVE, outstanding: [LAUNCH_CALL] },
    parentReader(transcript, SESSION),
  )
  assert.equal(run?.callId, LAUNCH_CALL)
  assert.equal(run?.status, 'running')
  assert.equal(run?.agents[0]?.state, 'running')
  // A run began when the call went out, not when the first agent it started wrote its first
  // line — ten minutes later here, and later still for an agent read tail-first.
  const started = new Date(run?.startedAt ?? 0).getTime()
  assert.ok(Math.abs(Date.now() - started - 20 * 60_000) < 5_000, 'started when the call was made')
  assert.ok((run?.durationMs ?? 0) >= 20 * 60_000, 'elapsed since the call, not since the agent')
})

test('a run whose call has been answered is over, however alive the session that ran it', async () => {
  const transcript = await store({
    agents: { a1: agentFile('fix it', [turn(ago(60_000), 'Bash', 'npm test', 30_000)]) },
    started: ['a1'],
    launched: true,
  })

  const [run] = await listWorkflows(
    transcript,
    { ...ALIVE, outstanding: [] },
    parentReader(transcript, SESSION),
  )
  assert.equal(run?.status, 'stopped')
  assert.equal(run?.agents[0]?.state, 'cancelled')
})

test('a session that never ran a workflow reports none, rather than failing to look', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aivis-agents-'))
  tempDirs.push(root)
  const transcript = path.join(root, `${SESSION}.jsonl`)
  await fs.writeFile(transcript, '')
  assert.deepEqual(await listWorkflows(transcript, ALIVE), [])
})

test('a run directory with no agent transcripts yet is not reported as a run', async () => {
  const transcript = await store({ agents: {}, started: [] })
  assert.deepEqual(await listWorkflows(transcript, ALIVE), [])
})

/*
 * Reading a live run is capped, because a real run's directory is megabytes and the page
 * watching it refetches on a timer. What the cap costs is therefore a design decision and
 * not an accident: the agents still going are the whole reason to look at a live run, so
 * they have to survive a cap that cuts anything, and the ones that come off are the ones
 * that already reported back and whose account the run's own JSON will carry when it files.
 * The run still counts what it did not read, so the rail's denominator stays honest.
 */
test('a run larger than the read cap keeps every agent still going and drops finished ones', async () => {
  const ids = Array.from({ length: 45 }, (_, i) => `a${String(i + 1).padStart(2, '0')}`)
  // The last five are still working; everything before them has come back.
  const working = new Set(ids.slice(40))
  const agents: Record<string, string> = {}
  const results: Record<string, unknown> = {}
  for (const id of ids) {
    agents[id] = agentFile(`task ${id}`, [
      turn(working.has(id) ? ago(5_000) : ago(8 * 60_000), 'Read', `${id}.ts`, 20_000),
    ])
    if (!working.has(id)) results[id] = { status: 'done' }
  }

  const [run] = await listWorkflows(await store({ agents, started: ids, results }), ALIVE)
  assert.ok(run)
  assert.equal(run.status, 'running')
  // Forty read, forty-five started: the count comes from the journal, which is one line per
  // agent and so stays cheap however many the run has.
  assert.equal(run.agents.length, 40)
  assert.equal(run.agentCount, 45)

  // Every agent still going is on the list, at the position the run started it in.
  assert.deepEqual(
    run.agents.filter((agent) => agent.state === 'running').map((agent) => agent.index),
    [41, 42, 43, 44, 45],
  )
  // What the cap took is the tail of the finished ones, and the list still reads in the
  // order the run started them rather than the order the cap chose to read them in.
  const indexes = run.agents.map((agent) => agent.index)
  assert.deepEqual(indexes, [...indexes].sort((a, b) => (a ?? 0) - (b ?? 0)))
  assert.deepEqual(indexes.slice(0, 35), Array.from({ length: 35 }, (_, i) => i + 1))
})
