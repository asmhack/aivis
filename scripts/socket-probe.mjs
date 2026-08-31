/**
 * Probe Claude Code's per-session message socket.
 *
 * Every running session listens on a Unix socket at `/tmp/cc-socks/<pid>.sock` and
 * accepts two newline-delimited frames: an `auth` frame carrying that session's own
 * `CLAUDE_CODE_MESSAGING_TOKEN`, then a `user` frame holding the message. The token
 * lives only in the session process's environment, so it is read from there.
 *
 * This is how one session delivers a message to another, and it is the path aivis takes to
 * reach a session running in a terminal — the same frames `server/deliver.ts` sends. Run it
 * against a live pid to check that path end to end without going through the UI.
 *
 * Usage: node scripts/socket-probe.mjs <pid> "<message>"
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Find the messaging socket and token for a session process.
 *
 * `ps` reports the environment a process was *spawned* with, so the messaging variables
 * are missing whenever the parent stripped them — which aivis's own driver does — and a
 * session re-exports them only to its own children. The socket is still there either way,
 * because every session listens at `/tmp/cc-socks/<pid>.sock`, so the pid-derived path is
 * the reliable answer and the environment is consulted only for the token. That token is
 * optional: the socket is mode 0600, so the operating system is the real gate.
 */
async function sessionChannel(pid) {
  let stdout = ''
  try {
    ;({ stdout } = await run('ps', ['eww', '-p', String(pid)], { maxBuffer: 4 * 1024 * 1024 }))
  } catch {
    // A pid that has already exited has no environment to read. Whether the socket exists
    // is what decides if the probe can go on, so that check is left to the caller.
  }
  const read = (key) => stdout.match(new RegExp(`${key}=(\\S+)`))?.[1] ?? null
  const derived = path.join('/tmp/cc-socks', `${pid}.sock`)
  return {
    socket: read('CLAUDE_CODE_MESSAGING_SOCKET') ?? (existsSync(derived) ? derived : null),
    token: read('CLAUDE_CODE_MESSAGING_TOKEN'),
  }
}

function deliver(socketPath, token, frame) {
  return new Promise((resolve, reject) => {
    const client = net.connect({ path: socketPath })
    let reply = ''
    client.setTimeout(5000, () => {
      client.destroy()
      reject(new Error('timed out'))
    })
    client.on('error', reject)
    client.on('data', (chunk) => {
      reply += String(chunk)
    })
    client.on('close', () => resolve(reply.trim()))
    client.on('connect', () => {
      if (token) client.write(JSON.stringify({ type: 'auth', token }) + '\n')
      client.write(JSON.stringify(frame) + '\n')
      // macOS needs a moment before the peer sees the write when the socket closes.
      setTimeout(() => client.end(), 300)
    })
  })
}

const [pid, text, sessionId, priority] = process.argv.slice(2)
if (!pid || !text) {
  console.error(
    'usage: node scripts/socket-probe.mjs <pid> "<message>" [session-id] [now|next|later]',
  )
  process.exit(1)
}

// The same frame server/deliver.ts sends, so what the probe proves is what aivis does.
// `session_id` is the guard: the receiver drops any frame naming a session other than its
// own, which is what stops a message reaching the wrong conversation when aivis has
// attributed the wrong process to a session.
const uuid = randomUUID()
const frame = {
  type: 'user',
  from: 'aivis',
  uuid,
  msg_id: uuid,
  priority: priority ?? 'next',
  ...(sessionId ? { session_id: sessionId } : {}),
  message: { role: 'user', content: text },
}

const { socket, token } = await sessionChannel(pid)
console.log(`  pid    ${pid}`)
console.log(`  socket ${socket ?? '(not found)'}`)
console.log(
  `  token  ${token ? `${token.slice(0, 6)}… (${token.length} chars)` : '(none — sending unauthenticated)'}`,
)
if (!socket) {
  console.error('  that process does not expose a message channel')
  process.exit(2)
}
console.log(`  uuid   ${uuid}`)
console.log(`  guard  ${sessionId ?? '(none — any session on this pid will take it)'}`)
const reply = await deliver(socket, token, frame)
console.log(`  reply  ${reply || '(closed without replying)'}`)
// The socket never acknowledges, so a write is not a delivery. The session records the
// message under the uuid above when it takes it off the queue; grep the transcript for it.
console.log('  written to the socket — confirm by finding the uuid in the transcript')
