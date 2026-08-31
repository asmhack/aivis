/**
 * Stop whatever is serving aivis, so `npm restart` can bind the port again.
 *
 * npm's built-in `restart` is `npm stop --if-present && npm start`, and with no `stop`
 * script that first half silently does nothing — the start then dies on EADDRINUSE and the
 * old server is still the one answering, which is how a stale process ends up serving a
 * freshly built front end.
 *
 * The port is the whole identity here: aivis is whatever holds it, however it was started.
 * Nothing else is touched, and a port nobody holds is a success rather than an error, since
 * `restart` on a machine where aivis is not running should still start it.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const port = Number(process.env.AIVIS_PORT ?? 4319)

/** PIDs listening on the port, via lsof — absent on some systems, which is not fatal. */
async function listeners() {
  try {
    const { stdout } = await run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'])
    return [...new Set(stdout.split('\n').map(Number).filter((pid) => pid > 0))]
  } catch (err) {
    // lsof exits 1 with no output when nothing matches, which is the common case.
    if (err.code === 1 && !err.stdout) return []
    if (err.code === 'ENOENT') {
      console.error(`aivis: cannot look up port ${port} — lsof is not installed`)
      return []
    }
    throw err
  }
}

const gone = async (pid) => {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

const found = await listeners()
if (found.length === 0) {
  console.log(`aivis: nothing listening on ${port}`)
  process.exit(0)
}

for (const pid of found) {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Already gone between the lookup and the signal.
  }
}

// A server mid-scan can take a moment to put the socket down; only then is SIGKILL fair.
for (let waited = 0; waited < 3000; waited += 100) {
  const alive = []
  for (const pid of found) if (!(await gone(pid))) alive.push(pid)
  if (alive.length === 0) break
  if (waited >= 2000) for (const pid of alive) process.kill(pid, 'SIGKILL')
  await new Promise((resolve) => setTimeout(resolve, 100))
}

console.log(`aivis: stopped ${found.join(', ')} on ${port}`)
