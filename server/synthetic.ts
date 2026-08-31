/**
 * Text Claude Code files as a user turn without the user having typed it.
 *
 * A transcript records more than the conversation. Slash commands, their output, hook
 * output, injected reminders, and the notification a finished background task posts all
 * arrive as `type: "user"` records wrapped in a tag. Nothing distinguishes them from a
 * prompt except the wrapper, so anything reading user turns has to know this list — and
 * getting it wrong is silent in the worst way: the text becomes the session's title, is
 * counted as a prompt, and is drawn in the conversation as something you said.
 *
 * This lived in two copies, one in `transcripts.ts` and one in `transcriptView.ts`, and
 * they drifted: neither knew about `<task-notification>`, which is the single most common
 * wrapper in a real store. One list, imported by both, is what stops that happening again.
 *
 * The list is empirical rather than guessed. Every wrapper below was found by scanning the
 * `type: "user"` records of a real `~/.claude/projects`; the command to reproduce that scan
 * is in the test beside this module. Add to it the same way, rather than from memory.
 */
const WRAPPERS = [
  // A slash command, its arguments, and the caveat block Claude Code puts before it.
  '<command-name>',
  '<command-message>',
  '<local-command',
  // `!` bash mode: what was run locally and what it printed. Neither is a prompt.
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
  // Injected by the harness rather than by anyone.
  '<system-reminder>',
  '<user-prompt-submit-hook>',
  // Posted when a background task finishes. The most common of the lot, and the one that
  // used to render as a message you had sent.
  '<task-notification>',
]

const CAVEAT = 'Caveat: The messages below were generated'

/**
 * What Claude Code writes when a turn is stopped, by Escape in the terminal or by the stop
 * aivis offers.
 *
 * It is the one entry here that carries no tag at all: a plain user record whose text is
 * the only thing marking it as the machine's own, which is why every reader that did not
 * know the string counted a stop as a prompt. The ending varies — '…by user for tool use]'
 * is the other common one — so only the opening is matched.
 *
 * `transcripts.ts` reads it before this filter, because a stop also says something about
 * the session's shape (it leaves it idle at its prompt) that dropping the record would
 * throw away. Everything else wants it gone for the same reason it wants a wrapper gone.
 */
export const INTERRUPTED = '[Request interrupted by user'

/** Whether a user record is Claude Code talking to itself rather than a prompt. */
export function isSynthetic(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith(CAVEAT) || t.startsWith(INTERRUPTED) || WRAPPERS.some((tag) => t.startsWith(tag))
}
