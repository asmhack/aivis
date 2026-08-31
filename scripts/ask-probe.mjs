/**
 * Probe the channel a question and a permission prompt arrive on.
 *
 * Claude Code decides some tool calls on its own and stops for the rest. In a terminal the
 * rest become a dialogue; in `--print` mode they have nowhere to appear, so Claude Code
 * denies them as "no prompt available in headless mode" and the turn carries on having
 * silently lost whatever it stopped to ask. `--permission-prompt-tool stdio` is what gives
 * them somewhere to appear: they arrive as `can_use_tool` control requests on the same
 * standard output as everything else, and are answered on standard input.
 *
 * Two shapes come down that one wire and this proves both. An `AskUserQuestion` carries
 * `requires_user_interaction: true` and its own questions, and is answered by allowing the
 * call with an `answers` map added to its input — keyed by each question's own text, with
 * several picked options joined by a comma and a space. Anything else is an ordinary
 * permission prompt, answered with allow or deny.
 *
 * The probe asks a throwaway session one multi-select question, answers it, then has it
 * write a file, and denies that. A working run prints both requests, the answers going
 * back, and the tool results the model actually saw.
 *
 * Usage: node scripts/ask-probe.mjs [model]
 */
import { spawn } from 'node:child_process'

const STRIPPED = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID',
]

const model = process.argv[2] ?? 'claude-haiku-4-5'
const env = { ...process.env }
for (const key of STRIPPED) delete env[key]

const proc = spawn(
  'claude',
  [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    model,
    // `default` rather than `auto`, so the Write below is certain to stop for a decision
    // instead of being approved by the classifier before it ever reaches this wire.
    '--permission-mode',
    'default',
    // Not a tool name. The sentinel that routes every decision onto standard output.
    '--permission-prompt-tool',
    'stdio',
  ],
  { cwd: '/tmp', env, stdio: ['pipe', 'pipe', 'pipe'] },
)

proc.stderr.setEncoding('utf8')
proc.stderr.on('data', (chunk) => process.stderr.write(`[stderr] ${chunk}`))

/** Write one control response back, which is what un-blocks the held tool call. */
function respond(requestId, response) {
  console.log('  → answering', JSON.stringify(response).slice(0, 300))
  proc.stdin.write(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    }) + '\n',
  )
}

let buffer = ''
proc.stdout.setEncoding('utf8')
proc.stdout.on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }

    if (event.type === 'control_request' && event.request?.subtype === 'can_use_tool') {
      const request = event.request
      console.log(`\n=== can_use_tool ${request.tool_name} ===`)
      console.log(JSON.stringify(request, null, 2).slice(0, 1600))

      if (Array.isArray(request.input?.questions)) {
        const answers = {}
        for (const question of request.input.questions) {
          const labels = question.options.map((option) => option.label)
          // Several picked options go back as one string joined with a comma and a space.
          // Claude Code will join an array itself, but only this form survives its own
          // check that every part names a real option, and that check is the difference
          // between "your questions have been answered" and "the user answered".
          answers[question.question] = question.multiSelect ? labels.slice(0, 2).join(', ') : labels[0]
        }
        respond(event.request_id, {
          behavior: 'allow',
          updatedInput: { ...request.input, answers },
          toolUseID: request.tool_use_id,
        })
      } else {
        respond(event.request_id, {
          behavior: 'deny',
          message: 'Denied by the probe, on purpose.',
          toolUseID: request.tool_use_id,
        })
      }
      continue
    }

    if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'text' && block.text.trim()) console.log('[assistant]', block.text.slice(0, 300))
        if (block.type === 'tool_use') console.log('[tool_use]', block.name)
      }
      continue
    }

    if (event.type === 'user') {
      for (const block of event.message?.content ?? []) {
        if (block.type !== 'tool_result') continue
        console.log(`[tool_result error=${block.is_error === true}]`, JSON.stringify(block.content).slice(0, 500))
      }
      continue
    }

    if (event.type === 'result') {
      console.log('\n[result]', event.subtype, `is_error=${event.is_error}`)
      proc.stdin.end()
      setTimeout(() => proc.kill(), 400)
    }
  }
})

proc.on('exit', (code) => console.log('[probe] exited', code))

proc.stdin.write(
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            'Two steps, in order. (1) Call AskUserQuestion once with one question "Which drinks?", ' +
            'header "Drinks", multiSelect true, and options "Tea", "Coffee", "Juice". ' +
            '(2) Then use the Write tool to create /tmp/aivis-ask-probe.txt containing the word hi. ' +
            'Say in one sentence what happened to each.',
        },
      ],
    },
  }) + '\n',
)
