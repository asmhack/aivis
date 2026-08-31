/**
 * What `server/projects.ts` writes into Claude Code's own config, and what it refuses to
 * hand to git.
 *
 * `trustProject` rewrites `~/.claude.json`, and on a machine that runs aivis that file is
 * the real thing: every project Claude Code has opened, the history and cost of each, the
 * MCP servers, the account it is signed in with. Nothing here may go near it. Every call
 * below is given a `home` of its own, made by `fs.mkdtemp`, and the home directory of the
 * person running the suite is never read, written or even named in this file — which is
 * the only way to be sure of that rather than to hope for it.
 *
 * The assertions are mostly about what did *not* change, because that is where the danger
 * is: a rewrite that drops a key, reverts a concurrent write or overwrites the one backup
 * costs settings that nothing else on the machine can put back.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { checkoutBranch, trustProject } from '../server/projects.ts'

const tempDirs: string[] = []

after(async () => {
  for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true })
})

async function tempDir(kind: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `aivis-projects-${kind}-`))
  tempDirs.push(dir)
  return dir
}

interface Config {
  [key: string]: unknown
  projects: Record<string, Record<string, unknown>>
}

const configPath = (home: string): string => path.join(home, '.claude.json')
const backupPath = (home: string): string => path.join(home, '.claude.json.aivis-backup')

/** A folder Claude Code already trusts, so that it can be checked for having survived. */
const OTHER_PROJECT = '/Users/someone/work/other'

/** Shaped like the real config: several unrelated top-level keys, and a project inside it. */
function sampleConfig(): Config {
  return {
    numStartups: 42,
    installMethod: 'native',
    autoUpdates: true,
    oauthAccount: { accountUuid: 'a1b2', emailAddress: 'someone@example.com' },
    mcpServers: { docs: { command: 'npx', args: ['-y', 'docs-server'] } },
    tipsHistory: { 'new-user-warmup': 3 },
    projects: {
      [OTHER_PROJECT]: {
        allowedTools: ['Bash(ls:*)'],
        history: [{ display: 'what does this do', pastedContents: {} }],
        hasTrustDialogAccepted: true,
        lastCost: 0.12,
      },
    },
  }
}

/** A fresh home with that config written into it, plus the exact bytes that were written. */
async function homeWith(body: string): Promise<{ home: string; raw: string }> {
  const home = await tempDir('home')
  await fs.writeFile(configPath(home), body)
  return { home, raw: body }
}

const readBack = async (home: string): Promise<Config> =>
  JSON.parse(await fs.readFile(configPath(home), 'utf8')) as Config

const readProjects = async (home: string): Promise<Record<string, Record<string, unknown>>> =>
  (await readBack(home)).projects

test('every key the config already had comes back unchanged, so trusting one folder cannot cost Claude Code the rest of its settings', async () => {
  const original = sampleConfig()
  const { home } = await homeWith(JSON.stringify(original, null, 2))
  const dir = '/Users/someone/work/new-project'

  assert.deepEqual(await trustProject(dir, home), { trusted: true, alreadyTrusted: false })

  // Compared as one serialised document rather than key by key, because the order of the
  // keys is part of "unchanged" too. The trusted folder is a key the config did not have,
  // so taking it back out must leave precisely the document that went in.
  const written = await readBack(home)
  delete written.projects[dir]
  assert.equal(JSON.stringify(written), JSON.stringify(original))
})

test('the trust flag lands under exactly the directory it was asked about, spelled the way it was given', async () => {
  const { home } = await homeWith(JSON.stringify(sampleConfig(), null, 2))
  const dir = '/Users/someone/work/a folder with spaces/and-a-dash'

  await trustProject(dir, home)

  const projects = await readProjects(home)
  assert.deepEqual(projects[dir], { hasTrustDialogAccepted: true })
  assert.deepEqual(Object.keys(projects), [OTHER_PROJECT, dir])
})

test('a folder Claude Code already knew about keeps every setting it had and only gains the trust flag', async () => {
  const original = sampleConfig()
  const dir = '/Users/someone/work/known'
  original.projects[dir] = {
    allowedTools: ['Bash(git status:*)'],
    hasTrustDialogAccepted: false,
    exampleFiles: ['README.md'],
  }
  const { home } = await homeWith(JSON.stringify(original, null, 2))

  assert.deepEqual(await trustProject(dir, home), { trusted: true, alreadyTrusted: false })
  assert.deepEqual((await readProjects(home))[dir], {
    allowedTools: ['Bash(git status:*)'],
    hasTrustDialogAccepted: true,
    exampleFiles: ['README.md'],
  })
})

test('a folder that is already trusted is reported as such and the config is not rewritten at all', async () => {
  const { home, raw } = await homeWith(JSON.stringify(sampleConfig(), null, 2))

  assert.deepEqual(await trustProject(OTHER_PROJECT, home), { trusted: true, alreadyTrusted: true })
  assert.equal(await fs.readFile(configPath(home), 'utf8'), raw)
  // No backup either: nothing was changed, so there is nothing to have kept a copy of.
  assert.deepEqual(await fs.readdir(home), ['.claude.json'])
})

test('the backup holds the config as it stood before aivis first touched it, and trusting a second folder does not overwrite it', async () => {
  const { home, raw } = await homeWith(JSON.stringify(sampleConfig(), null, 2))

  await trustProject('/Users/someone/work/first', home)
  assert.equal(await fs.readFile(backupPath(home), 'utf8'), raw)

  await trustProject('/Users/someone/work/second', home)
  assert.equal(
    await fs.readFile(backupPath(home), 'utf8'),
    raw,
    'the second call must not replace the backup with a config aivis had already changed',
  )

  const projects = await readProjects(home)
  assert.equal(projects['/Users/someone/work/first']?.hasTrustDialogAccepted, true)
  assert.equal(projects['/Users/someone/work/second']?.hasTrustDialogAccepted, true)
  // The config and its backup, and nothing else: a temp file left beside them would sit
  // next to the real config for ever.
  assert.deepEqual((await fs.readdir(home)).sort(), ['.claude.json', '.claude.json.aivis-backup'])
})

test('a config that is not valid JSON is reported as untrusted and left byte for byte as it was', async () => {
  const { home, raw } = await homeWith('{ "projects": { "/a": { "hasTrustDialogAccepted": tru')

  assert.deepEqual(await trustProject('/Users/someone/work/anything', home), {
    trusted: false,
    alreadyTrusted: false,
  })
  assert.equal(await fs.readFile(configPath(home), 'utf8'), raw)
  assert.deepEqual(await fs.readdir(home), ['.claude.json'])
})

test('a config that parses to something other than an object is left alone too, since there is nowhere in it to record trust', async () => {
  for (const body of ['null', '[1, 2, 3]', '"a string"']) {
    const { home } = await homeWith(body)
    assert.deepEqual(
      await trustProject('/Users/someone/work/anything', home),
      { trusted: false, alreadyTrusted: false },
      `${body} should be refused rather than rewritten`,
    )
    assert.equal(await fs.readFile(configPath(home), 'utf8'), body)
  }
})

test('a home with no config in it is left with none, because a config aivis invented would be worse than an untrusted folder', async () => {
  const home = await tempDir('empty-home')

  assert.deepEqual(await trustProject('/Users/someone/work/anything', home), {
    trusted: false,
    alreadyTrusted: false,
  })
  assert.deepEqual(await fs.readdir(home), [])
})

test('folders trusted at the same moment all end up in the file, because the writes are queued rather than raced', async () => {
  const original = sampleConfig()
  const { home } = await homeWith(JSON.stringify(original, null, 2))
  const dirs = [1, 2, 3, 4].map((n) => `/Users/someone/work/at-once-${n}`)

  const results = await Promise.all(dirs.map((dir) => trustProject(dir, home)))
  assert.deepEqual(
    results,
    dirs.map(() => ({ trusted: true, alreadyTrusted: false })),
  )

  // Every one of them has to be in the file. A call that read before its neighbour wrote
  // would put that neighbour's folder back to how it found it, which is the lost update.
  const projects = await readProjects(home)
  for (const dir of dirs) {
    assert.equal(projects[dir]?.hasTrustDialogAccepted, true, `${dir} was written and then lost`)
  }
  assert.deepEqual(projects[OTHER_PROJECT], original.projects[OTHER_PROJECT])
  assert.deepEqual((await fs.readdir(home)).sort(), ['.claude.json', '.claude.json.aivis-backup'])
})

/**
 * A config large enough that rewriting it is not over inside one turn of the event loop.
 *
 * The lost update this guards against lives in the gap between reading the config and
 * renaming the replacement over it, and on a config of a few hundred bytes that gap is too
 * short for anything to land in. A real `~/.claude.json` on a machine that has run Claude
 * Code for a while is megabytes of history, so the test uses one of about that size and the
 * gap becomes tens of milliseconds — wide enough for another writer to get in, which is
 * exactly the situation the guard exists for.
 */
function bulkyConfig(): Config {
  const config = sampleConfig()
  config.tipsHistory = Object.fromEntries(
    Array.from({ length: 20_000 }, (_, n) => [`tip-${n}`, 'x'.repeat(40)]),
  )
  return config
}

test('a write another process makes while the config is being rewritten survives, rather than being rolled back to what aivis read', async () => {
  const { home } = await homeWith(JSON.stringify(bulkyConfig(), null, 2))
  // The backup is written on the first call only, and writing it is one more thing that
  // would have to be raced. Putting it there in advance leaves just the rewrite under test.
  await fs.writeFile(backupPath(home), 'taken before this test ran')

  const dir = '/Users/someone/work/raced'
  const trust = trustProject(dir, home)

  // Another `claude` recording something of its own, the way a careful writer does it:
  // read, change one key, write beside the original and rename over it.
  const external = JSON.parse(await fs.readFile(configPath(home), 'utf8')) as Config
  external.numStartups = 4242
  const temp = path.join(home, 'external.tmp')
  await fs.writeFile(temp, JSON.stringify(external, null, 2))
  await fs.rename(temp, configPath(home))

  const result = await trust

  // Whichever order the two writes settled in, the other process's key has to still be
  // there. Either aivis saw the change and carried it, or it noticed the file had moved
  // under it and gave up; what it may never do is put back the config as it found it.
  const written = await readBack(home)
  assert.equal(written.numStartups, 4242, "the other process's write was rolled back")
  assert.deepEqual(written.projects[OTHER_PROJECT], sampleConfig().projects[OTHER_PROJECT])
  if (result.trusted) assert.equal(written.projects[dir]?.hasTrustDialogAccepted, true)
  // A retry writes a fresh temp file each time, and each abandoned one has to go.
  assert.deepEqual((await fs.readdir(home)).sort(), ['.claude.json', '.claude.json.aivis-backup'])
})

/**
 * The branch guards are checked against a directory that is not a repository.
 *
 * A name git would read as an option has to be refused before `checkoutBranch` asks git
 * anything, so the refusal is visible without a repository to switch: it comes back as the
 * unusable-name answer, where a name of an ordinary shape gets as far as git and comes back
 * with what git found instead. Building a repository to test the rest would mean committing
 * to one, and the guard that matters — a name that could be a flag never reaching argv — is
 * fully decided before any of that.
 */
const NOT_A_BRANCH_NAME = 'that is not a usable branch name'

test('a branch name git would read as a flag is refused outright, before git is asked anything at all', async () => {
  const dir = await tempDir('not-a-repo')

  for (const branch of ['--orphan=evil', '-Bmain', '--detach', '-q', '-', '--end-of-options', '']) {
    assert.equal(
      await checkoutBranch(dir, branch),
      NOT_A_BRANCH_NAME,
      `${JSON.stringify(branch)} must not reach git`,
    )
  }
})

test('a branch name carrying a control character is refused too, since no ref git made could contain one', async () => {
  const dir = await tempDir('not-a-repo')
  const tab = String.fromCharCode(9)
  const nul = String.fromCharCode(0)

  for (const branch of [`main${tab}evil`, `main${nul}`, `${nul}main`]) {
    assert.equal(await checkoutBranch(dir, branch), NOT_A_BRANCH_NAME)
  }
})

test('a name of an ordinary shape gets past that first guard, which is what makes the refusals above about the name and not the directory', async () => {
  const dir = await tempDir('not-a-repo')

  const failure = await checkoutBranch(dir, 'aivis-no-such-branch-0f3a')
  assert.ok(
    failure && failure !== NOT_A_BRANCH_NAME,
    `expected git's own answer for an ordinary name, got ${JSON.stringify(failure)}`,
  )
})

/**
 * The rest of the branch path, against a repository git actually made.
 *
 * Everything above stops before git is asked anything, which proves the refusals happen
 * early but proves nothing about the switch itself: the argv could be misspelled, the
 * allow-list could reject every real branch, and the tests would still pass. These run
 * against a scratch repository so that both halves are visible — a branch that exists is
 * switched to, and a name that could be a flag leaves HEAD and the refs exactly as they
 * were.
 *
 * The repository is built with `git init` in a temp directory, never in the checkout the
 * suite is running from, and the only state it touches is its own.
 */
const git = promisify(execFile)

/**
 * The installed git as a pair of numbers, or null when there is no git to ask.
 *
 * `git switch` and `--end-of-options` both arrived in git 2.24, so on anything older the
 * switch cannot work and there is nothing here to assert. That is a skip rather than a
 * failure, because it is the machine that is out of date rather than the code.
 */
async function gitVersion(): Promise<[number, number] | null> {
  try {
    const { stdout } = await git('git', ['--version'], { timeout: 4000 })
    const match = /(\d+)\.(\d+)/.exec(stdout)
    return match ? [Number(match[1]), Number(match[2])] : null
  } catch {
    return null
  }
}

function tooOldForSwitch(version: [number, number] | null): boolean {
  return version === null || version[0] < 2 || (version[0] === 2 && version[1] < 24)
}

/** A repository with one empty commit and a second branch, in a temp directory of its own. */
async function scratchRepo(): Promise<string> {
  const dir = await tempDir('repo')
  const identity = ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false']
  await git('git', ['-C', dir, 'init', '-q'], { timeout: 15000 })
  await git('git', ['-C', dir, ...identity, 'commit', '-q', '--allow-empty', '-m', 'first'], {
    timeout: 15000,
  })
  await git('git', ['-C', dir, 'branch', 'other'], { timeout: 15000 })
  return dir
}

const headOf = async (dir: string): Promise<string> =>
  (await git('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 4000 })).stdout.trim()

const refsOf = async (dir: string): Promise<string> =>
  (await git('git', ['-C', dir, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/'], {
    timeout: 4000,
  })).stdout

test('a branch the repository really has is switched to, which is the half no guard can prove', async (t) => {
  if (tooOldForSwitch(await gitVersion())) {
    t.skip('git is missing or older than 2.24, which has no `git switch` to call')
    return
  }
  const dir = await scratchRepo()
  const before = await headOf(dir)
  assert.notEqual(before, 'other', 'the scratch repository should start on its first branch')

  assert.equal(await checkoutBranch(dir, 'other'), null)
  assert.equal(await headOf(dir), 'other')

  // And back, so that the switch is shown to work in both directions rather than to have
  // landed on `other` by whatever name `git init` happened to give the first branch.
  assert.equal(await checkoutBranch(dir, before), null)
  assert.equal(await headOf(dir), before)
})

test('asking for the branch that is already checked out is a no-op rather than an error', async (t) => {
  if (tooOldForSwitch(await gitVersion())) {
    t.skip('git is missing or older than 2.24, which has no `git switch` to call')
    return
  }
  const dir = await scratchRepo()
  const current = await headOf(dir)

  assert.equal(await checkoutBranch(dir, current), null)
  assert.equal(await headOf(dir), current)
})

test('a name git would read as a flag changes nothing in a real repository either, not even a branch it could have created', async (t) => {
  if (tooOldForSwitch(await gitVersion())) {
    t.skip('git is missing or older than 2.24, which has no `git switch` to call')
    return
  }
  const dir = await scratchRepo()
  const head = await headOf(dir)
  const refs = await refsOf(dir)

  for (const branch of ['-Bother', '--orphan=evil', '--detach', '-q', '--end-of-options']) {
    assert.equal(
      await checkoutBranch(dir, branch),
      NOT_A_BRANCH_NAME,
      `${JSON.stringify(branch)} must not reach git`,
    )
  }
  // `--orphan=evil` would have left the repository on a branch with no commits, and
  // `-Bother` would have moved `other` onto HEAD, so the refs are compared whole.
  assert.equal(await headOf(dir), head)
  assert.equal(await refsOf(dir), refs)
})

test('a well-formed name the repository does not have is refused by the allow-list, before git is asked to switch', async (t) => {
  if (tooOldForSwitch(await gitVersion())) {
    t.skip('git is missing or older than 2.24, which has no `git switch` to call')
    return
  }
  const dir = await scratchRepo()
  const head = await headOf(dir)

  // A tag or a commit-ish is a real thing git would happily check out, and neither is a
  // local branch, so neither gets through: the guard is membership, not shape.
  for (const branch of ['no-such-branch', 'HEAD~1', 'origin/other', 'refs/heads/other']) {
    assert.equal(await checkoutBranch(dir, branch), 'no branch of that name exists here')
  }
  assert.equal(await headOf(dir), head)
})
