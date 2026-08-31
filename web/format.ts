import type { ContextLimit } from '../shared/types.ts'

/** Format a token count compactly, for example `128.4k`. */
export function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

/** Format an ISO timestamp as an age, for example `4m` or `9d`. */
export function age(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

/** Format a millisecond span as `1h 07m`, `49m`, or `48s`. */
export function duration(ms: number | null): string {
  if (!ms || ms < 0) return '—'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** Shorten a model id to the part worth reading, for example `opus-5`. */
export function model(value: string | null): string {
  if (!value) return '—'
  return value.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

/** Replace a home-directory prefix with `~` so paths fit on a card. */
export function homePath(value: string): string {
  const match = value.match(/^\/Users\/[^/]+/)
  return match ? '~' + value.slice(match[0].length) : value
}

/** Pick the one input field that says what a tool call is doing. */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  const keysByTool: Record<string, string[]> = {
    Bash: ['command'],
    Read: ['file_path'],
    Write: ['file_path'],
    Edit: ['file_path'],
    NotebookEdit: ['file_path'],
    Grep: ['pattern'],
    Glob: ['pattern'],
    Agent: ['description', 'prompt'],
    Task: ['description', 'prompt'],
    WebFetch: ['url'],
    WebSearch: ['query'],
    Skill: ['skill'],
  }
  // A question's input is a list of questions rather than a string anywhere, so the
  // fallback below would search it and come back with nothing, leaving the only tool call
  // that is addressed to you as the one with no summary on it.
  if (name === 'AskUserQuestion') {
    const questions = Array.isArray(input.questions) ? input.questions : []
    const first = questions[0] as { question?: unknown } | undefined
    if (typeof first?.question !== 'string') return ''
    return questions.length > 1 ? `${first.question} (+${questions.length - 1} more)` : first.question
  }
  for (const key of keysByTool[name] ?? []) {
    const value = input[key]
    if (typeof value === 'string' && value) return value
  }
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value) return value
  }
  return ''
}

/** Format a timestamp as a wall-clock time for the transcript view. */
export function clock(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** Format a byte count for display, for example `108 MB`. */
export function bytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`
  if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MB`
  if (value >= 1024) return `${Math.round(value / 1024)} KB`
  return `${value} B`
}

/** Format a millisecond span as prose, for example `4 hours` or `2 minutes`. */
export function spanWords(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return `${Math.round(ms / 1000)} seconds`
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  const hours = Math.round(minutes / 60)
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
}

/**
 * Say how big a session's context window is and how aivis knows.
 *
 * The source matters because four of the five answers are inferred. A bar drawn against a
 * window nobody confirmed should say so on hover rather than read as measurement.
 */
export function contextNote(used: number, limit: ContextLimit): string {
  const scale = `${used.toLocaleString()} of ${limit.tokens.toLocaleString()} tokens of context`
  const how: Record<ContextLimit['source'], string> = {
    reported: 'Window size reported by Claude Code itself, via your status line.',
    exceeded: 'The long window, proved by this session already holding more than 200k tokens.',
    model: 'The long window, named by the model id this session records.',
    settings: 'The long window, because your configured default asks for it on this model family.',
    assumed: 'The standard window, assumed because nothing on disk says otherwise. Publish it from your status line to be sure — see the README.',
  }
  return `${scale}. ${how[limit.source]}`
}
