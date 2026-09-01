import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { socketFor } from './registry.ts'
import type { OutgoingImage } from '../shared/types.ts'

const ATTACHMENT_DIR = path.join(os.tmpdir(), 'aivis-attachments')
const ATTACHMENT_TTL_MS = 24 * 3600_000

/**
 * When the receiving session should take the message up.
 *
 * `next` is the protocol's own default and the one that behaves like typing into a busy
 * terminal: the message joins the queue and is read at the session's next opportunity
 * rather than shouldering into the middle of a tool call. `now` jumps the queue and
 * `later` waits behind everything already in it.
 */
export type DeliveryPriority = 'now' | 'next' | 'later'

export interface DeliveryOptions {
  /**
   * The session the message is meant for. The receiver drops any frame whose `session_id`
   * does not match its own, which is what makes a wrong pid a message that fails to arrive
   * rather than one that lands in someone else's conversation. Since the pid now comes from
   * the client's own record where there is one — `server/registry.ts` — this is the backstop
   * for the case where there is not, and the reason that case is safe to guess in. Set
   * `AIVIS_SOCKET_SESSION_GUARD=0` to send without the check.
   */
  sessionId?: string
  priority?: DeliveryPriority
}

export interface DeliveryOutcome {
  /** Whether the frame reached the socket. It says nothing about the session accepting it. */
  ok: boolean
  /**
   * The uuid the session will record the message under once it takes it off the queue.
   * Watching the transcript for this is the only delivery receipt available, because the
   * socket closes without replying.
   */
  uuid: string
  /** Absolute paths any attached images were written to. */
  attachments: string[]
  /**
   * Why a failure happened, when aivis decided against the delivery rather than merely
   * failing to reach the socket. Refusing an attachment directory that is not ours is the
   * case that matters: the caller can say so instead of reporting an unreachable session.
   */
  error?: string
}

/**
 * Write attached images somewhere the session can read them.
 *
 * The receiver requires `message.content` to be a plain non-empty string and discards any
 * frame that carries content blocks, so base64 images cannot ride along in the message the
 * way they do on the driver's stdin. It also queues the prompt with attachment expansion
 * turned off, so an `@path` reference is not resolved for it either. Writing the bytes to
 * disk and naming the absolute paths in the text is therefore the one route that survives:
 * the session reads them with its own tools.
 *
 * `root` is threaded through to `prepareAttachmentDir` for the tests only, and defaults to the
 * one directory delivery ever uses. Nothing is written until that call has vouched for it.
 */
export async function materialize(
  images: OutgoingImage[],
  id: string,
  root: string = ATTACHMENT_DIR,
): Promise<string[]> {
  if (images.length === 0) return []
  const checked = await prepareAttachmentDir(root)
  void sweepAttachments(checked)
  // The random suffix mkdtemp adds means this directory is one we created ourselves or none
  // at all — unlike a name derived from the uuid, there is no path another process could
  // have got to first, and mkdtemp gives it mode 0700 in the same step.
  const dir = await fs.mkdtemp(path.join(checked, `${id}-`))
  const written: string[] = []
  for (const [index, image] of images.entries()) {
    // A name from the browser is untrusted, so only its basename is kept and anything
    // exotic falls back to a generated one. `.` and `..` survive the character filter and
    // would resolve to a directory rather than a file, so they count as exotic too.
    const base = path.basename(image.name ?? '').replace(/[^\w.-]/g, '')
    const suffix = image.mediaType.split('/')[1] ?? 'png'
    const named = base && base !== '.' && base !== '..' ? base : `image-${index + 1}.${suffix}`
    const file = path.join(dir, named)
    // The bytes are readable only by the account that wrote them rather than at the umask
    // default, because a pasted screenshot is as private as the conversation it came from.
    await fs.writeFile(file, Buffer.from(image.data, 'base64'), { mode: 0o600 })
    written.push(file)
  }
  return written
}

/**
 * Create the directory attachments live under, or refuse to touch it.
 *
 * On Linux `os.tmpdir()` is the `/tmp` every account on the machine shares, so this path is
 * predictable and another user can reach it first. A directory that is already there is
 * therefore not automatically ours: it may belong to someone else, or be a symlink aimed at
 * a directory of our own that we would then write attachments into and, far worse, sweep.
 * `recursive: false` turns an existing path into an EEXIST we inspect rather than the silent
 * no-op `recursive: true` performs — which is what let a pre-created directory keep its own
 * owner and mode — and `lstat` judges the entry itself instead of following a symlink to
 * whatever it points at. Anything that is not a plain directory belonging to this user is
 * refused, so no write and no removal ever happens inside it. A directory that *is* ours but
 * has a loose mode is simply tightened, since only this account could have widened it.
 *
 * (macOS is not exposed either way: its `os.tmpdir()` is the per-user `/var/folders` path.)
 *
 * `root` is a parameter purely so the tests can aim these checks at a scratch directory they
 * own and watch each refusal happen; the delivery path never passes one, so production is
 * always the module constant. It is deliberately not an environment variable: a settable
 * `AIVIS_ATTACHMENT_DIR` would hand anyone who can influence aivis's environment the very
 * "point the sweep at a directory of mine" primitive these checks exist to deny.
 */
export async function prepareAttachmentDir(root: string = ATTACHMENT_DIR): Promise<string> {
  try {
    await fs.mkdir(root, { recursive: false, mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const stat = await fs.lstat(root)
  // Under lstat a symlink is a symlink, so this rejects one pointing at a real directory.
  if (!stat.isDirectory()) {
    throw new Error(`${root} is not a plain directory, so no attachment was written`)
  }
  // Windows has neither uids nor meaningful permission bits, and no process.getuid to ask.
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid === undefined) return root
  if (stat.uid !== uid) {
    throw new Error(`${root} belongs to another user, so no attachment was written`)
  }
  if ((stat.mode & 0o077) !== 0) {
    await fs.chmod(root, 0o700)
    const tightened = await fs.lstat(root)
    if (!tightened.isDirectory() || tightened.uid !== uid || (tightened.mode & 0o077) !== 0) {
      throw new Error(`${root} cannot be made private, so no attachment was written`)
    }
  }
  return root
}

/**
 * Delete attachment directories older than a day.
 *
 * Nothing else removes them: the receiving session reads each file by absolute path when
 * it takes the message up, and there is no moment afterwards that is reliably "done". A
 * screenshot pasted into the composer would otherwise sit in the temp directory until the
 * operating system got round to it, so the next paste sweeps the last one.
 *
 * `root` is only ever the directory `prepareAttachmentDir` has just vouched for. A recursive
 * removal aimed at a directory nobody has proved is ours is precisely the primitive an
 * attacker who pre-created the predictable path would be after, so this takes the checked
 * path as an argument rather than reading the constant for itself.
 */
export async function sweepAttachments(root: string): Promise<void> {
  const cutoff = Date.now() - ATTACHMENT_TTL_MS
  let names: string[]
  try {
    names = await fs.readdir(root)
  } catch {
    return
  }
  for (const name of names) {
    const entry = path.join(root, name)
    try {
      // lstat, and a recursive removal only for a real directory, so anything else is judged
      // on its own age and deleted as the entry it is rather than followed into a target.
      const stat = await fs.lstat(entry)
      if (stat.mtimeMs < cutoff) {
        await fs.rm(entry, { recursive: stat.isDirectory(), force: true })
      }
    } catch {
      // An attachment that cannot be swept costs a few kilobytes of temp space, which is
      // not worth failing a message delivery over.
    }
  }
}

/**
 * Deliver a message into a running session over its own socket.
 *
 * Every top-level Claude Code session listens on `/tmp/cc-socks/<pid>.sock` and accepts a
 * newline-delimited `user` frame — the transport behind Claude Code's cross-session
 * messaging. The socket is mode 0600 and owned by the user, so the operating system is the
 * access gate: only the user's own processes can connect, which is exactly the boundary
 * aivis wants. No token is required to deliver.
 *
 * The message reaches the live session directly, mid-turn included, so a terminal and
 * aivis write to one conversation instead of resuming it as a second process. What arrives
 * is a *peer* message: the session is told it came from another Claude session rather than
 * from the user, and that it carries none of the user's authority. That is deliberate on
 * Claude Code's part — it is what stops one session laundering permissions through another
 * — and there is no frame that claims user authority. Anything needing the weight of the
 * user's own turn has to go through the driver, which owns the process and writes to its
 * standard input.
 *
 * The protocol is undocumented, so a failure to reach the socket resolves to `ok: false`
 * and the caller falls back to resume-as-a-second-process.
 *
 * `CLAUDE_CODE_MESSAGING_TOKEN` from aivis's own environment is sent as a best-effort auth
 * frame when present: current builds ignore it, but a build that starts checking a token is
 * more likely to accept a valid one than none.
 */
export async function deliverToSession(
  pid: number,
  text: string,
  images: OutgoingImage[] = [],
  options: DeliveryOptions = {},
): Promise<DeliveryOutcome> {
  const uuid = randomUUID()
  // The path the session recorded for itself, which is not always the one this would derive.
  const sock = await socketFor(pid)
  try {
    await fs.access(sock)
  } catch {
    return { ok: false, uuid, attachments: [] }
  }

  let attachments: string[] = []
  try {
    attachments = await materialize(images, uuid)
  } catch (error) {
    // Refusing an attachment directory that is not ours is a decision aivis made, not a
    // session it could not reach, so the reason travels back with the outcome instead of
    // leaving the caller to report a failure it cannot explain.
    const reason = error instanceof Error ? error.message : 'attachments could not be written'
    return { ok: false, uuid, attachments: [], error: reason }
  }

  const body = attachments.length
    ? `${text}${text ? '\n\n' : ''}Images attached from aivis, read them from disk:\n${attachments
        .map((file) => `- ${file}`)
        .join('\n')}`
    : text
  // An empty string is discarded by the receiver, so there is nothing to send.
  if (!body) return { ok: false, uuid, attachments }

  const guard = process.env.AIVIS_SOCKET_SESSION_GUARD !== '0'
  const frame: Record<string, unknown> = {
    type: 'user',
    from: 'aivis',
    uuid,
    msg_id: uuid,
    priority: options.priority ?? 'next',
    message: { role: 'user', content: body },
  }
  if (guard && options.sessionId) frame.session_id = options.sessionId
  const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN

  const ok = await new Promise<boolean>((resolve) => {
    const client = net.connect({ path: sock })
    let settled = false
    const finish = (done: boolean): void => {
      if (settled) return
      settled = true
      client.destroy()
      resolve(done)
    }
    client.setTimeout(5000, () => finish(false))
    client.on('error', () => finish(false))
    client.on('close', () => finish(true))
    client.on('connect', () => {
      if (token) client.write(JSON.stringify({ type: 'auth', token }) + '\n')
      client.write(JSON.stringify(frame) + '\n')
      // macOS registers the write only after a short delay when the socket closes.
      setTimeout(() => client.end(), 250)
    })
  })

  return { ok, uuid, attachments }
}
