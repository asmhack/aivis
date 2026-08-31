/**
 * What the `start` base in `server/changes.ts` counts as the session's work.
 *
 * "vs session start" is measured against the last commit made before the session's first
 * record, and that commit anchors only half of the question. Anything already uncommitted
 * when the session began differs from it too, and untracked files are the worst of it:
 * an uncommitted edit eventually ages out at the next commit, while a file nobody ever
 * added to git stays in `git ls-files --others` forever. Left alone, a session that has
 * done nothing but read a file opens its files tab on every stray download in the tree.
 *
 * The second anchor is the file's own mtime, because git records no time for a working-tree
 * edit. So the tests below build a repository where each file's history is known exactly —
 * committed before the session, edited before it, edited during it, deleted, untracked and
 * old, untracked and new — and then check that each base claims the files it should and
 * says how many it left out.
 */

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { changeSet } from '../server/changes.ts'
import type { ChangeSet } from '../shared/types.ts'

const run = promisify(execFile)
const temps: string[] = []

after(async () => {
  for (const dir of temps) await fs.rm(dir, { recursive: true, force: true })
})

const MINUTE = 60_000

/**
 * git in a scratch repository, with an identity of its own and, where it matters, a date.
 *
 * The dates are the point of most of this: `start` picks its base by asking git for the
 * newest commit before the session began, so a commit made "now" would leave every test
 * here dependent on how long the suite took to reach it.
 */
async function git(dir: string, args: string[], at?: number): Promise<void> {
  const date = at === undefined ? new Date().toISOString() : new Date(at).toISOString()
  await run(
    'git',
    [
      '-C',
      dir,
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'user.name=t',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { timeout: 15000, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } },
  )
}

async function repo(kind: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `aivis-changes-${kind}-`))
  temps.push(dir)
  await git(dir, ['init', '-q'])
  return dir
}

/** Write a file and give it the mtime it would carry had it been written at `at`. */
async function writeAt(dir: string, rel: string, text: string, at: number): Promise<void> {
  const full = path.join(dir, rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, text)
  await fs.utimes(full, at / 1000, at / 1000)
}

const pathsIn = (set: ChangeSet): string[] => set.files.map((file) => file.path).sort()

/**
 * A repository whose every file has a known history, and the moment a session began in it.
 *
 * The commit is an hour old, the session ten minutes old, and the edits that predate the
 * session sit between the two — which is the case the base commit cannot tell apart from
 * the session's own work on its own.
 */
async function tidyHistory(kind: string): Promise<{ dir: string; startedAt: string }> {
  const dir = await repo(kind)
  const now = Date.now()
  const committed = now - 60 * MINUTE
  const before = now - 30 * MINUTE
  const during = now - MINUTE

  for (const rel of ['kept.txt', 'edited-before.txt', 'edited-during.txt', 'removed.txt']) {
    await writeAt(dir, rel, 'one\ntwo\n', committed)
  }
  await git(dir, ['add', '-A'], committed)
  await git(dir, ['commit', '-q', '-m', 'the base'], committed)

  await writeAt(dir, 'edited-before.txt', 'one\ntwo\nthree\n', before)
  await writeAt(dir, 'edited-during.txt', 'one\ntwo\nfour\n', during)
  await fs.rm(path.join(dir, 'removed.txt'))
  await writeAt(dir, 'old-untracked.txt', 'left here weeks ago\n', before)
  await writeAt(dir, 'new-untracked.txt', 'written by the session\n', during)

  return { dir, startedAt: new Date(now - 10 * MINUTE).toISOString() }
}

test('the start base claims only the files written since the session began', async () => {
  const { dir, startedAt } = await tidyHistory('start')

  const set = await changeSet(dir, 'start', startedAt)

  assert.equal(set.isRepo, true)
  assert.equal(
    set.baseFellBack,
    false,
    'the hour-old commit predates the session, so nothing fell back',
  )
  assert.deepEqual(pathsIn(set), ['edited-during.txt', 'new-untracked.txt', 'removed.txt'])
  // The edit made half an hour before the session and the file left untracked in the same
  // half hour: both differ from the base commit, neither is this session's doing.
  assert.equal(set.predating, 2)
})

test('the uncommitted base still shows the whole tree, whoever wrote it and whenever', async () => {
  const { dir, startedAt } = await tidyHistory('head')

  const set = await changeSet(dir, 'head', startedAt)

  assert.deepEqual(pathsIn(set), [
    'edited-before.txt',
    'edited-during.txt',
    'new-untracked.txt',
    'old-untracked.txt',
    'removed.txt',
  ])
  // "Uncommitted" is a question about the tree rather than the session, so it leaves
  // nothing out and has nothing to report leaving out.
  assert.equal(set.predating, 0)
})

test('a session that has changed nothing reports nothing, however untidy the tree it started in', async () => {
  const dir = await repo('untidy')
  const now = Date.now()
  await writeAt(dir, 'readme.md', 'first\n', now - 60 * MINUTE)
  await git(dir, ['add', '-A'], now - 60 * MINUTE)
  await git(dir, ['commit', '-q', '-m', 'the base'], now - 60 * MINUTE)
  for (let n = 0; n < 40; n += 1) {
    await writeAt(dir, `dump-${n}.json`, '{}\n', now - 20 * 24 * 60 * MINUTE)
  }

  const set = await changeSet(dir, 'start', new Date(now - MINUTE).toISOString())

  assert.deepEqual(
    set.files,
    [],
    'a fresh session in a repository full of stale untracked files changed none of them',
  )
  assert.equal(set.predating, 40)
})

test('a deleted file stays in the list, since a deletion leaves no mtime to judge it by', async () => {
  const { dir, startedAt } = await tidyHistory('deleted')

  const set = await changeSet(dir, 'start', startedAt)
  const removed = set.files.find((file) => file.path === 'removed.txt')

  assert.equal(removed?.status, 'deleted')
})

test('a file written a moment before the first record is kept, since not every filesystem keeps sub-second mtimes', async () => {
  const dir = await repo('grace')
  const now = Date.now()
  await writeAt(dir, 'readme.md', 'first\n', now - 60 * MINUTE)
  await git(dir, ['add', '-A'], now - 60 * MINUTE)
  await git(dir, ['commit', '-q', '-m', 'the base'], now - 60 * MINUTE)

  const startedAt = now - 10 * MINUTE
  await writeAt(dir, 'a-second-early.txt', 'rounded down\n', startedAt - 1000)
  await writeAt(dir, 'an-hour-early.txt', 'genuinely older\n', startedAt - 60 * MINUTE)

  const set = await changeSet(dir, 'start', new Date(startedAt).toISOString())

  assert.deepEqual(pathsIn(set), ['a-second-early.txt'])
  assert.equal(set.predating, 1)
})
