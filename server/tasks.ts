/**
 * Background tasks a session started and has not been told the end of.
 *
 * Claude Code can hand work off to run outside the turn that asked for it — a Workflow, a
 * subagent, a long shell command. The turn carries on immediately, and when the work
 * finishes a `<task-notification>` is filed as a user record naming the tool call it
 * belongs to. Between those two records the task is running, and nothing else in the
 * transcript says so.
 *
 * That pairing is the whole mechanism, and it is structural rather than prose: the
 * notification carries `<tool-use-id>`, which is the id of the `tool_use` block that
 * started the task. Checked across a real store of 1,594 transcripts, 341 notifications
 * joined to their launching call and none failed to, so this is worth relying on. The
 * alternative — reading the run's own files off disk — is what made the removed review
 * queue expensive, and this needs no I/O at all beyond the transcript already being read.
 *
 * The catch is that the closing half is not guaranteed. A session killed mid-task, or one
 * whose notification was never written, leaves a launch with no end, and a task believed to
 * be running for ever is worse than not showing it at all. Two things bound that: only a
 * session with a live process can be running anything, and a task older than
 * `AIVIS_TASK_WINDOW_HOURS` is dropped. On this machine that window turned 25 phantom
 * `SendMessage` tasks, the oldest eight days old, into nothing.
 */

/** Tools whose calls always run outside the turn. */
const ALWAYS = new Set(['Workflow'])

/** Tools that run outside the turn unless the call says otherwise. */
const BY_DEFAULT = new Set(['Agent', 'Task', 'SendMessage', 'Monitor'])

/** Tools that run outside the turn only when the call asks for it. */
const ON_REQUEST = new Set(['Bash'])

/**
 * Read `run_in_background` from a call's input.
 *
 * Almost always a boolean, but the string `"true"` occurs in the wild, so both are read
 * rather than trusting the type.
 */
function askedForBackground(input: Record<string, unknown> | undefined): boolean | undefined {
  const value = input?.run_in_background
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return undefined
}

/** Whether a tool call hands its work off to run outside the turn that made it. */
export function isBackgroundCall(tool: string, input: Record<string, unknown> | undefined): boolean {
  const asked = askedForBackground(input)
  if (ALWAYS.has(tool)) return true
  if (BY_DEFAULT.has(tool)) return asked !== false
  if (ON_REQUEST.has(tool)) return asked === true
  return false
}

/**
 * The tool calls a notification reports the end of.
 *
 * One notification names one task, but they arrive batched into a single record often
 * enough that reading every id is cheaper than reasoning about when it happens.
 */
export function finishedTaskIds(text: string): string[] {
  if (!text.includes('<task-notification>')) return []
  return [...text.matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>/g)]
    .map((match) => match[1]?.trim() ?? '')
    .filter((id) => id.length > 0)
}
