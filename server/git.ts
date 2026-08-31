import { runBounded } from './bounded.ts'
import type { GitState } from '../shared/types.ts'

const EMPTY: GitState = { branch: null, filesChanged: 0, insertions: 0, deletions: 0, isRepo: false }

const cache = new Map<string, { at: number; state: GitState }>()

/**
 * Report uncommitted change size in `cwd`.
 *
 * The counts come from `git diff --shortstat HEAD`, which covers staged and unstaged
 * changes to tracked files. Untracked files are not counted, because listing them is
 * slower and a new file the agent has not staged is rarely what you are reviewing.
 * Results are cached per directory, since several sessions often share one.
 */
export async function gitState(cwd: string, maxAgeMs = 10000): Promise<GitState> {
  const hit = cache.get(cwd)
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.state

  const state = await read(cwd)
  cache.set(cwd, { at: Date.now(), state })
  return state
}

/*
 * Both calls go through `bounded.ts` rather than plain `execFile`.
 *
 * A `timeout` alone leaves Node waiting for a child that was signalled to actually exit, and
 * `git` on a stale network mount is in the one state where it will not: the fleet refresh
 * awaits this for every directory it knows about, so one repository on a broken mount would
 * otherwise stop the whole dashboard from updating. The cooldown is keyed on the directory,
 * because a repository that cannot be read says nothing about the others.
 */
async function read(cwd: string): Promise<GitState> {
  const key = `git ${cwd}`
  const head = await runBounded('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    timeoutMs: 4000,
    key,
  })
  if (head.failed) return EMPTY
  const branch = head.stdout.trim() || null

  // A repository without commits has no HEAD to diff against; the branch still shows, and a
  // failure here reads as no changes rather than as no repository.
  const diff = await runBounded('git', ['-C', cwd, 'diff', '--shortstat', 'HEAD'], {
    timeoutMs: 6000,
    key,
  })
  // Example: " 3 files changed, 42 insertions(+), 7 deletions(-)"
  const filesChanged = Number(diff.stdout.match(/(\d+) files? changed/)?.[1] ?? 0)
  const insertions = Number(diff.stdout.match(/(\d+) insertions?\(\+\)/)?.[1] ?? 0)
  const deletions = Number(diff.stdout.match(/(\d+) deletions?\(-\)/)?.[1] ?? 0)

  return { branch, filesChanged, insertions, deletions, isRepo: true }
}
