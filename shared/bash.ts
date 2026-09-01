import type { BashRun, ParsedBashRun } from './types.ts'

/**
 * The `!` bash line, in the exact shape Claude Code records it.
 *
 * Typing `!ls` in the terminal does not send anything to the model. The CLI runs the
 * command itself and writes two `type: "user"` records into the transcript — the command in
 * `<bash-input>`, then its output in `<bash-stdout>` immediately followed by
 * `<bash-stderr>` — so the run becomes context for whatever you ask next rather than a turn
 * of its own. Nothing about that crosses the stream-json protocol aivis speaks to a driven
 * session, which is why aivis has to run the command itself and write records that look the
 * same.
 *
 * Producing that text and reading it back are the same piece of knowledge, and the two
 * halves live here together for the reason `synthetic.ts` gives for its own list: when the
 * writer and the reader of a format are in different files they drift, and the drift is
 * silent. `server/bash.ts` formats with this, `server/transcriptView.ts` parses with it, and
 * the test beside it checks a round trip so neither can move alone.
 *
 * The shapes below were read off a real `~/.claude/projects` rather than guessed. Both tags
 * of the output record are always written, `<bash-stderr>` included when it is empty.
 */

/**
 * Make text safe to sit inside a tag.
 *
 * Whatever a command prints is about to be wrapped in `<bash-stdout>` and read by a model
 * that treats these tags as structure, so output containing `</bash-stdout>` would end the
 * block early and everything after it would read as though the session itself had said it.
 * Escaping `<` closes that, and escaping `&` is what keeps the escaping reversible — without
 * it a command that legitimately prints `&lt;` would come back as `<`.
 *
 * This is also what the CLI does: a `!gcloud auth login` in a real transcript has its
 * `&client_id=` recorded as `&amp;client_id=`.
 */
export function escapeTags(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
}

/**
 * Undo `escapeTags`, so what is shown is what the command actually printed.
 *
 * Order matters and is the reverse of the escape: `&lt;` has to become `<` while `&amp;` is
 * still spelled out, or `&amp;lt;` — a command that really did print `&lt;` — would decode
 * one step too far and arrive as `<`.
 */
export function unescapeTags(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&amp;/g, '&')
}

/**
 * What a run says about itself beyond stdout and stderr.
 *
 * The native format has nowhere to put an exit status, a kill, or the fact that output was
 * cut short — the terminal shows you those directly, so the CLI never had to record them.
 * A session driven from a browser has no such channel, and a `npm test` that exited 1 while
 * printing nothing to stderr would otherwise read as a clean run. So aivis appends its own
 * line to the stderr block, marked so it cannot be mistaken for the command's own output,
 * and only when there is something the two tags could not already say.
 */
export function bashNote(run: BashRun): string {
  const parts: string[] = []
  // A stopped run says so ahead of everything else, because it is the fact that explains the
  // output: what is above the note is a command cut off partway, not a command that failed.
  if (run.stopped) parts.push('stopped from aivis before it finished')
  else if (run.timedOut) parts.push(`killed after ${Math.round(run.timeoutMs / 1000)}s`)
  else if (run.exitCode !== 0 && run.exitCode !== null) parts.push(`exit status ${run.exitCode}`)
  if (run.failure) parts.push(run.failure)
  if (run.truncated) parts.push(`output truncated at ${Math.round(run.maxBytes / 1024)} KB`)
  return parts.length > 0 ? `[aivis] ${parts.join('; ')}` : ''
}

/**
 * A run's stderr as both the model and the page should see it: what the command printed,
 * then aivis's own note if there is one. Shared so the two cannot disagree about whether a
 * command failed.
 */
/**
 * One finished run as the pair of records Claude Code would have written.
 *
 * Both records are produced as one string because aivis cannot write to the transcript: the
 * text travels as a user message and the session records whatever it is handed, so a run
 * that wants to be two records has to arrive as the text of two records.
 */
export function bashStderr(run: BashRun): string {
  return [run.stderr, bashNote(run)].filter((part) => part.length > 0).join('\n')
}

export function formatBashRun(run: BashRun): string {
  const stderr = bashStderr(run)
  return (
    `<bash-input>${escapeTags(run.command)}</bash-input>\n` +
    `<bash-stdout>${escapeTags(run.stdout)}</bash-stdout>` +
    `<bash-stderr>${escapeTags(stderr)}</bash-stderr>`
  )
}

/**
 * The runs waiting on a session, as the text to put in front of the next message.
 *
 * A blank line separates them from what you actually typed, so the model reads the runs as
 * context that arrived before the request rather than as part of it.
 */
export function formatBashPrefix(runs: BashRun[]): string {
  if (runs.length === 0) return ''
  return runs.map(formatBashRun).join('\n') + '\n\n'
}

/**
 * The id a run is shown under while the daemon is still holding it.
 *
 * A held run is in no transcript, so the entry drawn for it has no uuid to take and is given
 * one made from the run's own id. The page needs to get that id back out — stopping a run is
 * asking for one named run, not for whatever is going on now — so the making and the reading
 * live together here, for the same reason the tags above do.
 */
export function pendingEntryUuid(runId: string): string {
  return `pending:${runId}`
}

/** The run behind a held entry, or `null` for an entry that came out of a transcript. */
export function pendingRunId(uuid: string): string | null {
  return uuid.startsWith('pending:') ? uuid.slice('pending:'.length) : null
}

const INPUT = /^<bash-input>([\s\S]*?)<\/bash-input>/
const OUTPUT = /^<bash-stdout>([\s\S]*?)<\/bash-stdout>(?:\s*<bash-stderr>([\s\S]*?)<\/bash-stderr>)?/

/**
 * Read the `!` runs off the front of a user record, and hand back whatever follows them.
 *
 * Two record shapes reach this. A terminal writes the command alone and its output as the
 * next record, so the run parsed here is incomplete and `readBashOutput` finishes it. aivis
 * writes both halves together and, because it delivers them in front of a real message
 * rather than on their own, may follow them with text — which is why this returns the
 * remainder instead of just a list. Ignoring that remainder is what would make a message
 * sent after a `!` line vanish from the conversation, since the record it shares now starts
 * with a tag that marks the whole thing as not-a-prompt.
 */
export function readBashRuns(body: string): { runs: ParsedBashRun[]; rest: string } | null {
  let rest = body
  const runs: ParsedBashRun[] = []
  for (;;) {
    const input = INPUT.exec(rest)
    if (!input) break
    rest = rest.slice(input[0].length).replace(/^\s*/, '')
    const output = OUTPUT.exec(rest)
    if (output) rest = rest.slice(output[0].length).replace(/^\s*/, '')
    runs.push({
      command: unescapeTags(input[1] ?? ''),
      stdout: unescapeTags(output?.[1] ?? ''),
      stderr: unescapeTags(output?.[2] ?? ''),
      // A record that carried no output tag is a terminal's first record and its output is
      // still to come. Saying so is what stops the fold below attaching to a finished run.
      complete: Boolean(output),
    })
  }
  return runs.length > 0 ? { runs, rest } : null
}

/**
 * Read an output-only record, which is how a terminal records the second half of a run.
 *
 * Returns `null` for anything else, including a record that opens with `<bash-input>` —
 * that one belongs to `readBashRuns`, which reads the pair together.
 */
export function readBashOutput(body: string): { stdout: string; stderr: string } | null {
  const output = OUTPUT.exec(body.trimStart())
  if (!output) return null
  return { stdout: unescapeTags(output[1] ?? ''), stderr: unescapeTags(output[2] ?? '') }
}
