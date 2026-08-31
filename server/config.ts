import os from 'node:os'
import path from 'node:path'

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

export const config = {
  /** Directory Claude Code writes transcripts to. */
  projectsDir: process.env.AIVIS_PROJECTS_DIR ?? path.join(os.homedir(), '.claude', 'projects'),
  port: num('AIVIS_PORT', 4319),
  host: process.env.AIVIS_HOST ?? '127.0.0.1',
  /**
   * Extra hostnames the browser may reach aivis on, comma separated.
   *
   * aivis has no authentication, so the only thing standing between it and any web page
   * you happen to have open is that the page's origin is not local. Requests are refused
   * unless their `Host` and `Origin` are loopback, the configured bind address, or named
   * here. Add an entry when you reach aivis through a name that is neither — a Tailscale
   * MagicDNS host, say, or a reverse proxy.
   */
  allowedHosts: (process.env.AIVIS_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0),
  /** Transcripts larger than this are read by sampling rather than in full. */
  fullParseMaxBytes: num('AIVIS_FULL_PARSE_MAX_MB', 4) * 1024 * 1024,
  /** A live session with no transcript activity for this long counts as stalled. */
  staleAfterMs: num('AIVIS_STALE_AFTER_SECONDS', 120) * 1000,
  /**
   * How recently a live session must have finished its turn to be queued as waiting on
   * you. Past this it is a terminal you left open, not a session holding for a reply.
   */
  waitingWindowMs: num('AIVIS_WAITING_WINDOW_HOURS', 4) * 3600_000,
  /**
   * How long a background task with no completion notice is still believed to be running.
   *
   * The notice is not guaranteed — a session killed mid-task never writes one — so without
   * a bound a task would be reported as running indefinitely.
   */
  taskWindowMs: num('AIVIS_TASK_WINDOW_HOURS', 6) * 3600_000,
  /** How often the fleet is recomputed, which refreshes status and process liveness. */
  refreshIntervalMs: num('AIVIS_REFRESH_SECONDS', 3) * 1000,
  /** Serve the built front-end from `dist` instead of relying on the Vite dev server. */
  serveStatic: process.env.AIVIS_SERVE_STATIC === '1',
  /** The Claude Code executable that drives sessions started from the browser. */
  claudeBin: process.env.AIVIS_CLAUDE_BIN ?? 'claude',
  /**
   * Permission mode for sessions aivis drives. `auto` approves routine work and asks for
   * the rest, and what it asks now comes to the browser to answer.
   */
  permissionMode: process.env.AIVIS_PERMISSION_MODE ?? 'auto',
  /**
   * Take the questions and permission prompts of sessions aivis drives and answer them
   * from the browser, rather than letting Claude Code deny what it cannot ask about.
   *
   * Set to `0` to go back to that, which is a real loss rather than a neutral choice: with
   * no prompt surface a decision is not deferred, it is denied, and the turn carries on
   * having lost whatever it stopped to ask. Nothing is left in the transcript for a
   * terminal to pick up afterwards.
   */
  answerAsks: process.env.AIVIS_ANSWER_ASKS !== '0',
  /**
   * Mark a folder trusted in `~/.claude.json` when a session is started in it, so the
   * terminal does not stop at the trust prompt after a handoff.
   */
  trustNewProjects: process.env.AIVIS_TRUST_NEW_PROJECTS !== '0',
  /**
   * Whether a `!` line typed in the browser runs a command on this machine.
   *
   * `auto`, the default, allows it on a loopback bind and refuses it on any other. `1`
   * allows it everywhere and `0` nowhere.
   *
   * The distinction the default draws is about who can reach the daemon, not about what the
   * daemon can do. aivis has no authentication, so on a LAN or Tailscale bind everyone who
   * can reach the port can already start a `claude` in any directory with `--permission-mode
   * auto`, which is arbitrary code execution by a longer route. Refusing `!` there does not
   * close that and is not claimed to: it withholds the short, quiet, instant route while
   * leaving the loud one — a session that appears in the fleet, writes a transcript and
   * costs tokens — as the only way through. If you want the shell on a shared bind, say so
   * with `AIVIS_BASH=1`; if you want neither, put the daemon behind something that
   * authenticates.
   */
  bashLines: (process.env.AIVIS_BASH ?? 'auto').trim().toLowerCase(),
  /**
   * How long a `!` command may run before its process group is killed.
   *
   * Generous on purpose. The command this exists for is an interactive cloud login that
   * hands off to a browser and waits for you to finish there, and a minute is not enough for
   * that. A command still running holds nothing but its own slot.
   */
  bashTimeoutMs: num('AIVIS_BASH_TIMEOUT_SECONDS', 300) * 1000,
  /**
   * How much of each of a `!` command's two streams is kept.
   *
   * Everything past this is read and dropped rather than left unread: a full pipe blocks the
   * command writing to it, so a reader that stops reading turns a `!cat big-file` into a
   * command that hangs until the timeout instead of one that prints its first quarter megabyte.
   */
  bashMaxOutputBytes: num('AIVIS_BASH_MAX_OUTPUT_KB', 256) * 1024,
}
