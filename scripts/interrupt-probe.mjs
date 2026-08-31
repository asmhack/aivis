/**
 * Probe Claude Code's interrupt control request.
 *
 * A session started with `--input-format stream-json` reads more than user messages on its
 * standard input: it also takes control requests, of which `interrupt` is the one that
 * stops a turn without ending the session. That is the piece aivis needs for a stop button,
 * and it is undocumented, so this proves it against a throwaway session rather than
 * assuming it.
 *
 * The probe starts a session, gives it something long to say, interrupts it a moment later,
 * and prints what came back. A working interrupt shows a `control_response` with
 * `subtype: "success"` and then a `result` for the turn, with the process still alive.
 *
 * Usage: node scripts/interrupt-probe.mjs [delay-ms] [model]
 */
import { spawn } from 'node:child_process'
import os from 'node:os'

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

const delay = Number(process.argv[2]) || 3000
const model = process.argv[3] ?? 'claude-haiku-4-5'

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
  ],
  { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] },
)

let buffer = ''
let interrupted = 0
const seen = []

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
    const label = [event.type, event.subtype].filter(Boolean).join('/')
    seen.push(label)
    if (event.type === 'control_response') {
      console.log(`  control_response  ${JSON.stringify(event.response ?? event)}`)
    }
    if (event.type === 'result') {
      const elapsed = interrupted ? Date.now() - interrupted : null
      console.log(
        `  result            subtype=${event.subtype} is_error=${event.is_error}` +
          (elapsed === null ? '' : ` (${elapsed}ms after the interrupt)`),
      )
    }
  }
})
proc.stderr.setEncoding('utf8')
proc.stderr.on('data', (chunk) => {
  const text = chunk.trim()
  if (text) console.error(`  stderr            ${text.slice(0, 200)}`)
})

proc.stdin.write(
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: 'Write the numbers 1 to 400, one per line, and nothing else.',
    },
  }) + '\n',
)
console.log(`  sent              a long prompt to a ${model} session`)

setTimeout(() => {
  interrupted = Date.now()
  proc.stdin.write(
    JSON.stringify({
      type: 'control_request',
      request_id: 'aivis-interrupt-probe',
      request: { subtype: 'interrupt' },
    }) + '\n',
  )
  console.log(`  sent              interrupt after ${delay}ms`)
}, delay)

setTimeout(() => {
  console.log(`  events            ${[...new Set(seen)].join(', ')}`)
  console.log(`  alive             ${proc.exitCode === null ? 'yes — the session survived' : 'no'}`)
  proc.stdin.end()
  proc.kill('SIGTERM')
  process.exit(0)
}, delay + 8000)
