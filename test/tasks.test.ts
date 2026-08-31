import { test } from 'node:test'
import assert from 'node:assert/strict'
import { finishedTaskIds, isBackgroundCall } from '../server/tasks.ts'

/*
 * The rules below are measured rather than assumed. Counting `tool_use` calls against the
 * `<task-notification>` records that closed them, over a real ~/.claude/projects:
 *
 *   Bash   40,180 calls,  215 notified  — only ever with run_in_background: true
 *   Agent      90 calls,   51 notified  — backgrounds by default, 14 calls opted out
 *   Workflow   57 calls,   45 notified  — always backgrounds
 *
 * Getting a rule wrong in the permissive direction is the expensive one: a call wrongly
 * believed to background is reported as running until the task window expires.
 */

test('a Workflow call always backgrounds, whatever its input says', () => {
  assert.equal(isBackgroundCall('Workflow', {}), true)
  assert.equal(isBackgroundCall('Workflow', undefined), true)
  // Seen in the wild as the string rather than the boolean, and it makes no difference here.
  assert.equal(isBackgroundCall('Workflow', { run_in_background: 'true' }), true)
})

test('an Agent backgrounds unless the call opts out, which is the tool’s own default', () => {
  assert.equal(isBackgroundCall('Agent', {}), true)
  assert.equal(isBackgroundCall('Agent', undefined), true)
  assert.equal(isBackgroundCall('Agent', { run_in_background: true }), true)
  assert.equal(isBackgroundCall('Agent', { run_in_background: false }), false)
  // `Task` is the same tool under its older name.
  assert.equal(isBackgroundCall('Task', {}), true)
})

/*
 * The rule that matters most: Bash is 40,180 of the calls in a real store and fewer than
 * 500 of them background. Defaulting it the other way would put a running pill on almost
 * every session on the machine.
 */
test('a Bash call backgrounds only when it explicitly asks to, which is the rare case', () => {
  assert.equal(isBackgroundCall('Bash', {}), false)
  assert.equal(isBackgroundCall('Bash', undefined), false)
  assert.equal(isBackgroundCall('Bash', { command: 'npm test' }), false)
  assert.equal(isBackgroundCall('Bash', { run_in_background: true }), true)
  assert.equal(isBackgroundCall('Bash', { run_in_background: 'true' }), true)
  assert.equal(isBackgroundCall('Bash', { run_in_background: false }), false)
})

test('a tool nobody has classified does not background, so a new tool cannot invent a stuck task', () => {
  assert.equal(isBackgroundCall('Read', {}), false)
  assert.equal(isBackgroundCall('Edit', { run_in_background: true }), false)
  assert.equal(isBackgroundCall('SomeFutureTool', {}), false)
})

test('a notification names the tool call it closes, which is the only thing that ever ends a task', () => {
  const notice = [
    '<task-notification>',
    '<task-id>wnfvqrhfw</task-id>',
    '<tool-use-id>toolu_01DzpS9P1WJGAduc6eeEzaPT</tool-use-id>',
    '<status>completed</status>',
    '</task-notification>',
  ].join('\n')
  assert.deepEqual(finishedTaskIds(notice), ['toolu_01DzpS9P1WJGAduc6eeEzaPT'])
})

test('several notifications batched into one record all close their own task', () => {
  const batched = [
    '<task-notification><tool-use-id>toolu_aaa</tool-use-id><status>completed</status></task-notification>',
    '<task-notification><tool-use-id>toolu_bbb</tool-use-id><status>stopped</status></task-notification>',
  ].join('\n')
  assert.deepEqual(finishedTaskIds(batched), ['toolu_aaa', 'toolu_bbb'])
})

test('a stopped task is closed as firmly as a completed one, since neither is still running', () => {
  const stopped = '<task-notification><tool-use-id>toolu_x</tool-use-id><status>stopped</status></task-notification>'
  assert.deepEqual(finishedTaskIds(stopped), ['toolu_x'])
})

test('ordinary text closes nothing, including a prompt that talks about the tags', () => {
  assert.deepEqual(finishedTaskIds('can you rerun that flow?'), [])
  assert.deepEqual(finishedTaskIds(''), [])
  // A tool-use-id outside a notification is some other record's business, not a completion.
  assert.deepEqual(finishedTaskIds('<tool-use-id>toolu_x</tool-use-id>'), [])
})
