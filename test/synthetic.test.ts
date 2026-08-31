import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSynthetic } from '../server/synthetic.ts'

/*
 * The list under test is empirical. To regenerate it against your own store, count the
 * opening tag of every non-sidechain `type: "user"` record under ~/.claude/projects:
 *
 *   grep -rhao '"type":"user".\{0,400\}' ~/.claude/projects --include=*.jsonl \
 *     | grep -o '<[a-z][a-z0-9-]*>' | sort | uniq -c | sort -rn | head
 *
 * Anything in that output which is not a prompt belongs in server/synthetic.ts.
 */

test('every wrapper Claude Code files as a user turn is recognised, so none is drawn as something you said', () => {
  const wrappers = [
    '<command-name>/code-review</command-name>',
    '<command-message>code-review is running…</command-message>',
    '<local-command-caveat>the output below</local-command-caveat>',
    '<local-command-stdout>ok</local-command-stdout>',
    '<bash-input>ls -la</bash-input>',
    '<bash-stdout>total 0</bash-stdout>',
    '<bash-stderr>no such file</bash-stderr>',
    '<system-reminder>remember the style guide</system-reminder>',
    '<user-prompt-submit-hook>hook output</user-prompt-submit-hook>',
    '<task-notification>a background task finished</task-notification>',
    'Caveat: The messages below were generated while running a command.',
  ]
  for (const text of wrappers) {
    assert.equal(isSynthetic(text), true, `${text.slice(0, 40)} should be synthetic`)
  }
})

/*
 * The regression this module exists for. `<task-notification>` is the most common wrapper
 * in a real store, and it was in neither of the two copies of this list that used to
 * exist — so a notification counted as a prompt, could become the session's title, and was
 * rendered in the conversation as a message the user had sent.
 */
test('a task notification is not a prompt, which is the case both old copies of this list missed', () => {
  const notification = [
    '<task-notification>',
    '<task-id>w8z57sjva</task-id>',
    '<status>stopped</status>',
    '<summary>No completion record was found for background workflow "verify-review-queue-removal".</summary>',
    '</task-notification>',
  ].join('\n')
  assert.equal(isSynthetic(notification), true)
})

/*
 * The stop marker is the one entry in the list that carries no tag, so every reader that
 * did not know the exact string counted pressing Escape as something the user typed: the
 * turn count went up, the conversation drew the marker as a message from you, and a session
 * stopped before its first prompt took the marker as its title.
 */
test('the marker a stopped turn leaves is not a prompt, even though it carries no wrapper tag', () => {
  assert.equal(isSynthetic('[Request interrupted by user]'), true)
  // The other ending it comes with, which is why only the opening is matched.
  assert.equal(isSynthetic('[Request interrupted by user for tool use]'), true)
  assert.equal(isSynthetic('\n  [Request interrupted by user]'), true)
  // Only the opening position counts, exactly as it does for a wrapper: a prompt that
  // talks about the marker is a prompt somebody wrote.
  assert.equal(isSynthetic('why does [Request interrupted by user] count as a prompt?'), false)
})

test('leading whitespace does not hide a wrapper, since records are not written trimmed', () => {
  assert.equal(isSynthetic('\n\n  <task-notification>done</task-notification>'), true)
  assert.equal(isSynthetic('   <system-reminder>x</system-reminder>'), true)
})

test('a real prompt is left alone, including one that merely talks about the tags', () => {
  const prompts = [
    'can you rerun that flow?',
    'Add a retry affordance to the payment step.',
    // A prompt that mentions a wrapper is still a prompt: only the opening position counts.
    'why does <task-notification> render as a user message?',
    'the fix is to add <bash-input> to the synthetic list',
    // Angle brackets that are not one of the known wrappers.
    '<div className="ask">is this filtered?</div>',
    '<thinking> should not be treated as a wrapper',
  ]
  for (const text of prompts) {
    assert.equal(isSynthetic(text), false, `${text.slice(0, 40)} should be a real prompt`)
  }
})

test('an empty or whitespace-only body is not claimed as synthetic, so the caller decides what to do with it', () => {
  assert.equal(isSynthetic(''), false)
  assert.equal(isSynthetic('   \n  '), false)
})
