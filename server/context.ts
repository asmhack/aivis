import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ContextLimit } from '../shared/types.ts'

/**
 * How big a session's context window actually is.
 *
 * A transcript never says. It records the model as `claude-opus-5` whether that session
 * is running the standard window or the 1M one, so a session holding 175k tokens looks
 * 88% full when it is in fact 18% full — a false alarm on exactly the number you would
 * act on. Nothing else on disk records the window either.
 *
 * Claude Code does know, and tells its status line. So this file works the same way the
 * rate-limit meter does: it reads what the status line published when that has been set
 * up, and otherwise infers the window from what can be proved or configured, saying which
 * of the two it did rather than presenting a guess as a fact.
 */

/** What every model holds unless it is running the long-context variant. */
export const STANDARD_CONTEXT = 200_000
export const LONG_CONTEXT = 1_000_000

/**
 * Model families whose window is the long one with nothing in the id to say so.
 *
 * The `[1m]` suffix exists to opt a standard-window model into the larger window, so a
 * model that ships at 1M never carries it — and would otherwise be read as a 200k model
 * and reported as three-quarters full when it is holding a seventh of its window.
 */
const ALWAYS_LONG = new Set(['fable'])

const DIR = path.join(os.homedir(), '.claude', 'aivis-context')

/** Captures older than this are ignored, and eventually deleted. */
const CAPTURE_TTL_MS = 14 * 24 * 3600_000

/** How long a directory listing is reused, since the fleet rescans far more often. */
const CACHE_MS = 5000

/** One session's context window as Claude Code reported it. */
export interface ReportedContext {
  /** Tokens the window holds. */
  size: number
  /** How full it was at the capture, as Claude Code's own percentage. */
  usedPercent: number
  capturedAt: number
}

let cache: { at: number; contexts: Map<string, ReportedContext> } | null = null
let prunedAt = 0

/**
 * Read every capture the status line has published, keyed by session id.
 *
 * One file per session rather than one file for all of them, so a status line — which is
 * a shell script rendering many sessions at once — never has to read, merge and rewrite a
 * shared file, and two sessions rendering at the same moment cannot lose each other's
 * capture.
 */
export async function reportedContexts(): Promise<Map<string, ReportedContext>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.contexts

  const contexts = new Map<string, ReportedContext>()
  let names: string[] = []
  try {
    names = await fs.readdir(DIR)
  } catch {
    // No captures published: the inference below carries the whole answer.
    cache = { at: Date.now(), contexts }
    return contexts
  }

  const now = Date.now()
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = await fs.readFile(path.join(DIR, name), 'utf8')
      const parsed = JSON.parse(raw) as {
        context_window?: { context_window_size?: number; used_percentage?: number }
        captured_at?: number
      }
      const size = parsed.context_window?.context_window_size
      if (typeof size !== 'number' || size <= 0) continue
      const capturedAt = typeof parsed.captured_at === 'number' ? parsed.captured_at * 1000 : 0
      if (now - capturedAt > CAPTURE_TTL_MS) continue
      contexts.set(name.slice(0, -'.json'.length), {
        size,
        usedPercent: parsed.context_window?.used_percentage ?? 0,
        capturedAt,
      })
    } catch {
      // A file being rewritten as it is read is skipped; the next scan gets it.
    }
  }

  cache = { at: now, contexts }
  if (now - prunedAt > 3600_000) {
    prunedAt = now
    void prune(names)
  }
  return contexts
}

/** Delete captures for sessions that stopped writing long ago, so the directory stays small. */
async function prune(names: string[]): Promise<void> {
  const cutoff = Date.now() - CAPTURE_TTL_MS
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = path.join(DIR, name)
    try {
      const stat = await fs.stat(file)
      if (stat.mtimeMs < cutoff) await fs.rm(file, { force: true })
    } catch {
      // A capture that cannot be pruned costs a few hundred bytes, so it is not worth
      // failing a scan over.
    }
  }
}

/**
 * The model family a setting names, ignoring the release and the variant suffix.
 *
 * `opus[1m]`, `claude-opus-5` and `claude-opus-4-8` are all `opus`, which is what lets a
 * configured default be matched against the model a transcript recorded.
 */
function family(value: string): string {
  const bare = value.replace(/\[1m\]$/, '').replace(/^claude-/, '')
  return bare.split('-')[0] ?? bare
}

/**
 * Decide how large one session's window is, and say how that was decided.
 *
 * The order is strictly by strength of evidence: what Claude Code reported, then what the
 * session has already proved by exceeding the standard window, then what its own model id
 * says, then what your settings would have given it, and only then the assumption.
 */
export function contextLimitFor(opts: {
  model: string | null
  contextWindow: number
  reported: ReportedContext | undefined
  /** The model a new session in this directory would inherit, as `defaults.ts` resolves it. */
  configured: string | null
}): ContextLimit {
  // A capture that claims a window smaller than the session has demonstrably used is a
  // stale one — an earlier session on a different model, or a file left behind — so the
  // proof below overrules it rather than clamping the bar at a hundred per cent.
  if (opts.reported && opts.reported.size >= opts.contextWindow) {
    return { tokens: opts.reported.size, source: 'reported' }
  }
  if (opts.contextWindow > STANDARD_CONTEXT) return { tokens: LONG_CONTEXT, source: 'exceeded' }
  if (opts.model && (opts.model.includes('[1m]') || ALWAYS_LONG.has(family(opts.model)))) {
    return { tokens: LONG_CONTEXT, source: 'model' }
  }
  // A transcript drops the `[1m]` suffix, so a session started on a long-context default
  // is indistinguishable from a standard one by its model id alone. Matching the family
  // is what recovers it: the settings say `opus[1m]`, the transcript says `claude-opus-5`,
  // and both are opus, so this session got the window that setting asks for.
  if (
    opts.configured?.includes('[1m]') &&
    opts.model &&
    family(opts.configured) === family(opts.model)
  ) {
    return { tokens: LONG_CONTEXT, source: 'settings' }
  }
  return { tokens: STANDARD_CONTEXT, source: 'assumed' }
}
