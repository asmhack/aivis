/**
 * What a scan decides about sessions and directories it cannot read the truth off directly.
 *
 * Two of `server/fleet.ts`'s judgements are guesses that the rest of the dashboard then
 * treats as fact, and both fail quietly when they go wrong. The first is liveness: pids are
 * attributed to transcripts by directory and recency, so a session aivis drives — which
 * writes nothing between turns and nothing at all while it waits on a decision — can lose
 * its own pid to a terminal started in the same checkout and come back looking finished.
 * The second is git state: the scan rations `git` so a store of hundreds of directories
 * does not cost a wave of processes every cycle, and the thing that must not be rationed is
 * the *first* read, because a directory that has never been read publishes "not a
 * repository" rather than "not known yet", which the session page believes.
 *
 * Both are driven here the way the server drives them: real `.jsonl` files under a
 * temporary projects directory, real repositories under a temporary work tree, and a real
 * `Fleet.refresh()`. `HOME` is redirected before the server modules are loaded, so nothing
 * in this file reads or writes the store, the parked registry or the git config of whoever
 * is running the suite.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aivis-fleet-'))

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const projectsDir = path.join(root, 'projects')
const home = path.join(root, 'home')
await fs.mkdir(projectsDir, { recursive: true })
await fs.mkdir(path.join(home, '.claude'), { recursive: true })

// Set before the first server module is loaded: `config.projectsDir` and the parked
// registry's path are both resolved at import time, so the import below has to come after.
process.env.AIVIS_PROJECTS_DIR = projectsDir
process.env.HOME = home

const { Fleet } = await import('../server/fleet.ts')

// --- Fixtures ----------------------------------------------------------------------------

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()

/** A record shape matching what Claude Code writes, per `scripts/make-fixtures.mjs`. */
function userPrompt(id: string, cwd: string, at: string, value: string): Record<string, unknown> {
  return { sessionId: id, cwd, type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'text', text: value }] } }
}

function assistantEnd(id: string, cwd: string, at: string): Record<string, unknown> {
  return {
    sessionId: id,
    cwd,
    type: 'assistant',
    timestamp: at,
    message: { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
  }
}

/** A tool call with no result after it: the shape of a session stopped mid-turn. */
function toolCall(id: string, cwd: string, at: string): Record<string, unknown> {
  return {
    sessionId: id,
    cwd,
    type: 'assistant',
    timestamp: at,
    message: {
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'tool_use', id: 'toolu-fleet-1', name: 'Bash', input: { command: 'npm test' } }],
    },
  }
}

/** Write a transcript into the store, under a project directory named after its cwd. */
async function transcript(id: string, cwd: string, rows: Record<string, unknown>[]): Promise<void> {
  const dir = path.join(projectsDir, cwd.replace(/[^A-Za-z0-9]/g, '-'))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${id}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

/**
 * A working directory that really is a checkout.
 *
 * `gitState` reports a directory as a repository only once `rev-parse HEAD` resolves, which
 * an empty repository's does not, so each one gets a commit. The identity is passed per
 * command rather than written into a config, and `HOME` is the temporary one, so nothing
 * here can reach the git configuration of the person running the suite.
 */
async function repo(name: string): Promise<string> {
  const dir = path.join(root, 'work', name)
  await fs.mkdir(dir, { recursive: true })
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  await run(
    'git',
    ['-c', 'user.email=fleet@example.invalid', '-c', 'user.name=fleet', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'first'],
    { cwd: dir },
  )
  return dir
}

/** A directory with no process of its own, which is every directory this file makes. */
async function quietSession(id: string, name: string, rows: (cwd: string) => Record<string, unknown>[]): Promise<string> {
  const cwd = path.join(root, 'work', name)
  await fs.mkdir(cwd, { recursive: true })
  await transcript(id, cwd, rows(cwd))
  return cwd
}

// --- Liveness the process scan missed ------------------------------------------------------

test('a session aivis drives is running even when the process scan attributed no pid to it', async () => {
  const id = 'b8e04d71-0000-4000-8000-0000000000a1'
  await quietSession(id, 'driven-idle', (cwd) => [
    userPrompt(id, cwd, ago(60_000), 'Ship the tier fix.'),
    assistantEnd(id, cwd, ago(30_000)),
  ])

  // Nothing on this machine has these temporary directories as its working directory, so the
  // scan attributes no pid to any session in this file — which is exactly the state a driven
  // session comes back in when a terminal in the same checkout takes the pid instead.
  const blind = new Fleet(
    () => false,
    () => false,
  )
  await blind.refresh()
  assert.equal(blind.get(id)?.status, 'ended', 'with no pid and no driver there is nothing running')

  const driven = new Fleet(
    () => false,
    () => true,
  )
  await driven.refresh()
  const session = driven.get(id)
  // Its turn ended, which is the reading that puts it in the attention queue as waiting on
  // you. Reporting `ended` would lose that row and offer to forget a session that is running.
  assert.equal(session?.status, 'idle')
  // The stand-in that told `toSession` it was running does not survive the call: what the
  // session publishes is the attribution the scan actually made, so nothing downstream can
  // read, report or signal a process that was never identified.
  assert.deepEqual(session?.livePids, [])
  assert.equal(session?.isForeground, false)
})

test('a driven session holding a decision reports working, and one merely driven does not', async () => {
  const id = 'b8e04d71-0000-4000-8000-0000000000a2'
  await quietSession(id, 'driven-held', (cwd) => [
    userPrompt(id, cwd, ago(30 * 60_000), 'Backfill the tier ids.'),
    toolCall(id, cwd, ago(10 * 60_000)),
  ])

  // Ten minutes of silence in the middle of a turn is a stall — the status whose whole
  // meaning is that aivis cannot say why a session went quiet. Being driven does not answer
  // that question; holding the decision it stopped for does, which is why the two predicates
  // are separate and only the second one changes this reading.
  const driven = new Fleet(
    () => false,
    () => true,
  )
  await driven.refresh()
  assert.equal(driven.get(id)?.status, 'stalled')

  const held = new Fleet(
    () => true,
    () => true,
  )
  await held.refresh()
  assert.equal(held.get(id)?.status, 'working')

  // A caller that only knows about held decisions gets the same answer it always did: the
  // liveness predicate defaults to the held one rather than to "never driven".
  const legacy = new Fleet(() => true)
  await legacy.refresh()
  assert.equal(legacy.get(id)?.status, 'working')
})

// --- Git state the scan rations ------------------------------------------------------------

/*
 * The rationing exists so that a store which has collected hundreds of project directories
 * does not spawn a pair of `git` processes for every one of them each cycle. What it must
 * not ration is the first read of a directory, because until that lands the fleet publishes
 * `branch: null, isRepo: false` — not an absence but a claim, byte for byte what a directory
 * that is not a checkout reports. The fleet list then drops the branch and the session page
 * hides the `start` and `head` change bases and seeds its own state from the lie.
 */
test('the first scan reads git for every directory, past the per-scan budget for re-reads', async () => {
  // GIT_QUIET_PER_SCAN is 8; ten quiet directories is more than one scan's re-read budget
  // and none of them has a live session, so under a single shared budget most would report
  // as non-repositories.
  const ids: string[] = []
  for (let i = 0; i < 10; i += 1) {
    const id = `b8e04d71-0000-4000-8000-0000000000b${i}`
    const cwd = await repo(`quiet-${i}`)
    await transcript(id, cwd, [
      userPrompt(id, cwd, ago(3 * 3600_000), 'Rename the column.'),
      assistantEnd(id, cwd, ago(3 * 3600_000)),
    ])
    ids.push(id)
  }

  const fleet = new Fleet()
  await fleet.refresh()

  for (const id of ids) {
    const session = fleet.get(id)
    assert.ok(session, `${id} should have been indexed`)
    assert.equal(session.git.isRepo, true, `${session.cwd} is a checkout and should say so on the first scan`)
    assert.equal(session.git.branch, 'main')
  }
})
