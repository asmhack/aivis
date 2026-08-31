import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { withDeadline } from './bounded.ts'
import { bashRefusal } from './bash.ts'
import { config } from './config.ts'
import { PARK_TTL_DAYS } from './parked.ts'
import type { Defaults, DefaultModel } from '../shared/types.ts'

/**
 * What a session inherits when you do not say otherwise.
 *
 * aivis omits `--model` when the new-session sheet is left on `default`, which hands the
 * choice to the CLI and leaves the sheet unable to say what it just picked. That is the
 * gap this file closes: it reads the same settings the CLI reads, in the same order, so
 * the sheet can name the model rather than only promising there is one.
 *
 * The thresholds travel with it for the same reason. `stalled` and `waiting on you` are
 * both defined by a number of minutes that is configurable, so the index has to be told
 * what those numbers currently are instead of hard-coding prose that quietly goes stale.
 */

/**
 * The model one settings file names, if it names one.
 *
 * A file can say it two ways — the `model` key, or `ANTHROPIC_MODEL` in its `env` block,
 * which the CLI exports into the session — and the plain key wins when both are present.
 */
function modelIn(settings: Record<string, unknown> | null): string | null {
  if (!settings) return null
  if (typeof settings.model === 'string' && settings.model.trim()) return settings.model.trim()
  const env = settings.env
  if (env && typeof env === 'object') {
    const fromEnv = (env as Record<string, unknown>).ANTHROPIC_MODEL
    if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  }
  return null
}

/**
 * How long a settings file gets to arrive before the answer is "there isn't one".
 *
 * `fs` has no timeout of its own, and this read happens once per session directory inside the
 * fleet refresh, which the server will not start again while the previous one is still going.
 * A project on a stale network mount would therefore park the whole dashboard on a file that
 * only ever supplies a default model, so the wait is bounded and expiry reads as absence.
 * The read itself cannot be cancelled and stays pending; only this caller stops waiting.
 */
const SETTINGS_READ_MS = 2000

async function readSettings(file: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await withDeadline<string | null>(fs.readFile(file, 'utf8'), SETTINGS_READ_MS, null)
    if (text === null) return null
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    // Missing is the common case, and malformed settings are the CLI's problem to report.
    return null
  }
}

/** Shorten a path under the home directory the way the rest of the UI writes them. */
function tilde(file: string): string {
  const home = os.homedir()
  return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file
}

/**
 * Resolved defaults, held briefly.
 *
 * The fleet scan asks for one per session every few seconds, and settings files change
 * when you edit them rather than while a scan runs, so re-reading three files per session
 * per scan would be pure waste.
 */
const cache = new Map<string, { at: number; model: DefaultModel }>()
const CACHE_MS = 30_000

/**
 * Resolve the model a session started in `cwd` would run on.
 *
 * The order matches Claude Code's own precedence: an explicit environment variable wins,
 * then the project's local settings, then the project's shared settings, then yours. A
 * managed enterprise policy sits above all of these and is not read here, so the answer
 * is described as inherited rather than guaranteed.
 */
export async function defaultModel(cwd: string | null): Promise<DefaultModel> {
  const key = cwd ?? ''
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.model
  const model = await resolveDefaultModel(cwd)
  cache.set(key, { at: Date.now(), model })
  return model
}

async function resolveDefaultModel(cwd: string | null): Promise<DefaultModel> {
  const fromEnv = process.env.ANTHROPIC_MODEL?.trim()
  if (fromEnv) return { value: fromEnv, source: 'ANTHROPIC_MODEL' }

  const files: string[] = []
  if (cwd) {
    files.push(path.join(cwd, '.claude', 'settings.local.json'))
    files.push(path.join(cwd, '.claude', 'settings.json'))
  }
  files.push(path.join(os.homedir(), '.claude', 'settings.json'))

  for (const file of files) {
    const value = modelIn(await readSettings(file))
    if (value) return { value, source: tilde(file) }
  }
  return { value: null, source: null }
}

/** Everything the index and the new-session sheet need in order to explain themselves. */
export async function defaults(cwd: string | null): Promise<Defaults> {
  return {
    model: await defaultModel(cwd),
    staleAfterMs: config.staleAfterMs,
    waitingWindowMs: config.waitingWindowMs,
    parkTtlDays: PARK_TTL_DAYS,
    bashRefusal: bashRefusal(),
  }
}
