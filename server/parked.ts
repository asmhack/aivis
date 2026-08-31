import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Sessions kept ready across a reboot.
 *
 * A session's liveness is a property of a running process, so shutting the laptop down
 * ends every one of them. Without a record of what was alive, a conversation you were in
 * the middle of comes back indistinguishable from the hundreds of transcripts you finished
 * months ago — which is the problem this file solves.
 *
 * Every session aivis sees alive is written here. When one later has no process, it is
 * reported as `parked` rather than `ended`: still yours, still one message from continuing,
 * just not currently running. Sending to it resumes it exactly as before — the registry
 * changes how a session is *presented*, never how it is driven.
 *
 * Nothing is restarted on boot. Waking a session costs a process and tokens, so it happens
 * when you actually write to it, not because a machine powered on.
 */

const REGISTRY_PATH = path.join(os.homedir(), '.claude', 'aivis-parked.json')

/** How long a session stays parked without being seen alive again. */
export const PARK_TTL_DAYS = Number(process.env.AIVIS_PARK_TTL_DAYS ?? 14) || 14
const PARK_TTL_MS = PARK_TTL_DAYS * 24 * 3600_000

/** An upper bound, so a long-running install cannot grow the file without limit. */
const MAX_ENTRIES = 400

interface Entry {
  cwd: string
  title: string
  /** ISO timestamp when aivis last saw a live process for this session. */
  lastAliveAt: string
}

interface RegistryFile {
  version: number
  sessions: Record<string, Entry>
}

/**
 * How long a deliberately finished session refuses to be parked again.
 *
 * A fleet scan reads every transcript before it records what it saw, so a scan that began
 * while a session was still running can call `see` for it moments after it was stopped, and
 * a plain delete would be undone by that in-flight pass. The mark outlives the scan; it is
 * short so that genuinely restarting the session later parks it as normal.
 */
const FINISH_GUARD_MS = 30_000

export class ParkedRegistry {
  private entries = new Map<string, Entry>()
  private finished = new Map<string, number>()
  private dirty = false
  private loaded = false
  private writing: Promise<void> | null = null

  /** Read the registry from disk, once. A missing or broken file starts an empty one. */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await fs.readFile(REGISTRY_PATH, 'utf8')
      const parsed = JSON.parse(raw) as RegistryFile
      for (const [id, entry] of Object.entries(parsed.sessions ?? {})) {
        if (entry && typeof entry.lastAliveAt === 'string') {
          this.entries.set(id, { cwd: entry.cwd ?? '', title: entry.title ?? '', lastAliveAt: entry.lastAliveAt })
        }
      }
    } catch {
      // No registry yet, or an unreadable one: start clean rather than fail the scan.
    }
    if (this.expire()) void this.save()
  }

  /** Note that a session is alive right now, so it can be parked when it stops. */
  see(id: string, cwd: string, title: string): void {
    const finishedAt = this.finished.get(id)
    if (finishedAt !== undefined) {
      // Ignore a scan that started before this session was deliberately finished.
      if (Date.now() - finishedAt < FINISH_GUARD_MS) return
      this.finished.delete(id)
    }
    const at = new Date().toISOString()
    const previous = this.entries.get(id)
    // Only the timestamp usually moves; rewriting on every scan would be pointless churn,
    // so a write is scheduled at most once a minute per session.
    if (previous && Date.parse(at) - Date.parse(previous.lastAliveAt) < 60_000 && previous.title === title) {
      return
    }
    this.entries.set(id, { cwd, title, lastAliveAt: at })
    this.dirty = true
  }

  /** Whether a session with no live process should still be presented as ready. */
  has(id: string): boolean {
    return this.entries.has(id)
  }

  /**
   * Mark a session as deliberately finished and forget it.
   *
   * Unlike `dismiss`, this also blocks a scan already in flight from parking it again, which
   * is what stops a session you just ended from reappearing as ready.
   */
  finish(id: string): void {
    this.finished.set(id, Date.now())
    this.dismiss(id)
  }

  /** Forget a session, so it drops back to being an ordinary ended one. */
  dismiss(id: string): boolean {
    if (!this.entries.delete(id)) return false
    this.dirty = true
    void this.save()
    return true
  }

  /** Forget every parked session at once. */
  clear(): number {
    const count = this.entries.size
    if (count === 0) return 0
    this.entries.clear()
    this.dirty = true
    void this.save()
    return count
  }

  /** Ids currently parked, newest first. */
  list(): { id: string; cwd: string; title: string; lastAliveAt: string }[] {
    return [...this.entries.entries()]
      .map(([id, entry]) => ({ id, ...entry }))
      .sort((a, b) => b.lastAliveAt.localeCompare(a.lastAliveAt))
  }

  /** Drop entries past their TTL, and the oldest beyond the cap. Returns true if any went. */
  private expire(): boolean {
    const cutoff = Date.now() - PARK_TTL_MS
    let removed = false
    for (const [id, entry] of this.entries) {
      if (Date.parse(entry.lastAliveAt) < cutoff) {
        this.entries.delete(id)
        removed = true
      }
    }
    if (this.entries.size > MAX_ENTRIES) {
      const ordered = [...this.entries.entries()].sort((a, b) =>
        a[1].lastAliveAt.localeCompare(b[1].lastAliveAt),
      )
      for (const [id] of ordered.slice(0, this.entries.size - MAX_ENTRIES)) {
        this.entries.delete(id)
        removed = true
      }
    }
    if (removed) this.dirty = true
    return removed
  }

  /**
   * Persist the registry when it has changed.
   *
   * Written then renamed, so a reader — or a machine losing power mid-write, which is
   * exactly the moment this file matters — never finds a half-written registry.
   */
  async save(): Promise<void> {
    if (!this.dirty) return
    // Collapse concurrent saves: whoever is writing will include the current state.
    if (this.writing) return this.writing
    this.dirty = false
    this.expire()
    const body: RegistryFile = { version: 1, sessions: Object.fromEntries(this.entries) }
    const temp = `${REGISTRY_PATH}.${process.pid}.tmp`
    this.writing = (async () => {
      try {
        await fs.writeFile(temp, JSON.stringify(body, null, 2), 'utf8')
        await fs.rename(temp, REGISTRY_PATH)
      } catch {
        // A registry that cannot be written costs presentation, not correctness, so the
        // scan carries on. The next save will try again.
        await fs.rm(temp, { force: true }).catch(() => {})
      } finally {
        this.writing = null
      }
    })()
    return this.writing
  }
}

export const parked = new ParkedRegistry()
