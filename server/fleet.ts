import { promises as fs } from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'
import { contextLimitFor, reportedContexts } from './context.ts'
import { defaultModel } from './defaults.ts'
import { gitState } from './git.ts'
import { liveProcesses, type LiveProcess } from './liveness.ts'
import { parked } from './parked.ts'
import { registeredSessions, type RegisteredSession } from './registry.ts'
import { TranscriptIndex, toSession } from './transcripts.ts'
import type { GitState, Session } from '../shared/types.ts'

/*
 * How the scan rations its per-directory work.
 *
 * Reading git state for a directory spawns two `git` processes, and the cost is per directory
 * rather than per session, so a store that has collected hundreds of project directories over
 * the years would spawn a pair for every one of them each time the reading expired — long
 * enough that a single scan outruns the refresh interval, at which point the server starts
 * dropping refreshes and the whole dashboard goes stale. So the scan re-reads git where
 * something is actually happening, and lets the quiet directories trickle through a few at a
 * time: a checkout whose sessions have all ended is not accumulating uncommitted changes at a
 * rate anyone is watching, and it is still re-read, just on a much longer cycle.
 *
 * The budget is on *re*-reads only. A directory nobody has read yet has no state to hold back,
 * and what the fleet would publish in its place is not a blank but a claim — no branch, not a
 * repository — indistinguishable from a directory that really is not a checkout, which the
 * session page then believes and acts on. That is wrong rather than stale, so every unread
 * directory is read on the scan that first sees it; the pool below is what keeps that bounded,
 * and the server is already accepting connections by the time the first scan runs.
 */
const GIT_ACTIVE_TTL_MS = 10_000
const GIT_QUIET_TTL_MS = 60_000
const GIT_QUIET_PER_SCAN = 8

/** How many directories are inspected at once, which bounds both the wait and the spawns. */
const LOOKUP_CONCURRENCY = 5

/**
 * What a directory reports if its git state is somehow still missing when sessions are built.
 *
 * `readGit` reads every directory it has never read, so in a completed scan nothing uses this;
 * it exists so that a directory the scan somehow skipped yields a shape rather than a crash.
 */
const UNREAD_GIT: GitState = { branch: null, filesChanged: 0, insertions: 0, deletions: 0, isRepo: false }

/**
 * Tracks every Claude Code session on this machine and keeps a current view of each.
 *
 * Session transcripts live at `<projects>/<project-slug>/<session-id>.jsonl`. Files
 * nested deeper belong to subagents and are not sessions in their own right, so the
 * scan only reads one level down.
 */
export class Fleet {
  private index = new TranscriptIndex()
  private sessions = new Map<string, Session>()
  private knownFiles = new Set<string>()
  /** Git state per directory, held across scans so a quiet one is not re-read every cycle. */
  private gitByCwd = new Map<string, { readAt: number; state: GitState }>()
  /** False until one scan has finished, which is what makes "moved since the last scan" mean anything. */
  private scanned = false

  /**
   * @param heldByDriver Whether aivis is holding a decision open for that session.
   * @param driven Whether aivis is running that session at all, holding a decision or not.
   *
   * The two answers settle two different questions, which is why they are two predicates.
   *
   * `heldByDriver` says *why* a session has gone quiet. One waiting on a permission prompt
   * writes nothing to its transcript until the prompt is answered, so from the file alone it
   * is indistinguishable from one that simply stopped, and it would report as `stalled` —
   * the one status that means aivis does not know why. The driver does know.
   *
   * `driven` says *whether it is running*, which the transcript cannot say either. Pids are
   * attributed to transcripts by directory and recency, and the session that guess most
   * easily misses is a driven one, because a driven session between turns or waiting on a
   * decision writes nothing, sinks to the bottom of its directory's recency order, and loses
   * the pid to a terminal somebody started in the same checkout. Its driver is holding the
   * child either way, so a driven session with no pid of its own is running all the same —
   * and that is true whether or not it currently has a decision outstanding, which is
   * exactly what the narrower `heldByDriver` cannot express.
   *
   * The default makes the two the same, so a caller that only knows about held decisions
   * behaves as it always did rather than silently gaining a liveness source it did not mean
   * to give.
   */
  constructor(
    private readonly heldByDriver: (sessionId: string) => boolean = () => false,
    private readonly driven: (sessionId: string) => boolean = heldByDriver,
  ) {}

  /** Find every session transcript, without reading any of them. */
  async discover(): Promise<string[]> {
    const files: string[] = []
    let projectDirs: string[] = []
    try {
      const entries = await fs.readdir(config.projectsDir, { withFileTypes: true })
      projectDirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(config.projectsDir, e.name))
    } catch {
      return files
    }
    for (const dir of projectDirs) {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path.join(dir, entry.name))
        }
      } catch {
        // A project directory that disappears between listings is skipped.
      }
    }
    return files
  }

  /**
   * Re-read every known transcript and rebuild the fleet.
   *
   * Returns the sessions whose displayed state changed since the previous call, so the
   * server can push only what moved instead of the whole list.
   */
  async refresh(): Promise<{ changed: Session[]; removed: string[] }> {
    const files = await this.discover()
    // Through the method rather than the module function, so a test can hand the scan a
    // process table of its own: what this does with one is the whole of what it decides.
    const processes = await this.processes()
    // Which process is running which session, where the client itself has said so. Read
    // beside the process scan because it is only believed about processes that scan found.
    const registered = await registeredSessions(processes)
    const contexts = await reportedContexts()
    await parked.load()
    const seen = new Set<string>()

    const parsed: { file: string; sessionId: string; cwd: string; lastActivityAt: string; moved: boolean }[] = []
    for (const file of files) {
      const acc = await this.index.ingest(file, config.fullParseMaxBytes)
      if (!acc || !acc.lastActivityAt) continue
      const sessionId = acc.sessionId ?? path.basename(file, '.jsonl')
      const previous = this.sessions.get(sessionId)
      parsed.push({
        file,
        sessionId,
        cwd: acc.cwd ?? path.dirname(file),
        lastActivityAt: acc.lastActivityAt,
        // Whether this transcript moved since the previous scan, which is what marks its
        // directory worth looking at again. The first scan has nothing to compare against
        // and would call every session on the machine new, so it counts none of them as
        // moved: the point of the comparison is to keep startup proportional to what is
        // running rather than to how much history the store has accumulated.
        moved: previous
          ? previous.lastActivityAt !== acc.lastActivityAt ||
            previous.transcriptBytes !== this.index.sizeOf(file)
          : this.scanned,
      })
      this.knownFiles.add(file)
    }

    const aliveFiles = assignLiveness(parsed, processes, registered)

    // Everything that belongs to a directory rather than to a session is resolved once per
    // directory, ahead of the loop below, so that ten sessions sharing a checkout cost one
    // lookup between them and the lookups run a few at a time instead of end to end.
    const dirs = new Map<string, { active: boolean; lastActivityAt: string }>()
    for (const entry of parsed) {
      const active =
        (aliveFiles.get(entry.file)?.length ?? 0) > 0 || this.driven(entry.sessionId) || entry.moved
      const dir = dirs.get(entry.cwd)
      if (!dir) {
        dirs.set(entry.cwd, { active, lastActivityAt: entry.lastActivityAt })
        continue
      }
      dir.active ||= active
      if (entry.lastActivityAt.localeCompare(dir.lastActivityAt) > 0) dir.lastActivityAt = entry.lastActivityAt
    }

    const models = new Map<string, string | null>()
    await pool([...dirs.keys()], LOOKUP_CONCURRENCY, async (cwd) => {
      models.set(cwd, (await defaultModel(cwd)).value)
    })
    await this.readGit(dirs)

    const changed: Session[] = []
    for (const entry of parsed) {
      const acc = this.index.get(entry.file)
      if (!acc) continue
      const pids = aliveFiles.get(entry.file) ?? []
      const held = this.heldByDriver(entry.sessionId)
      // A session aivis drives that the process scan could not name a pid for. Its driver is
      // holding the child, so it is running; only which pid it runs under is unknown.
      const drivenWithoutPid = pids.length === 0 && this.driven(entry.sessionId)
      const session = toSession(entry.file, acc, {
        // `toSession` reads liveness off this list, and most of what it decides follows from
        // that one reading: a session with no process is `ended` whatever its last turn did,
        // its unanswered question is dropped because nothing is there to answer it, and its
        // background work is dropped because nothing is there to run it. All three are wrong
        // for a driven session that merely lost the pid guess, so it is handed a stand-in
        // that says "running, pid unknown". The stand-in goes no further than this call: the
        // line below puts back the attribution the scan actually made, which is still none,
        // so nothing downstream can mistake it for a process to read, report or signal.
        livePids: drivenWithoutPid ? [0] : pids,
        isForeground: pids.length > 0,
        git: this.gitByCwd.get(entry.cwd)?.state ?? UNREAD_GIT,
        contextLimit: contextLimitFor({
          model: acc.model,
          contextWindow: acc.tokens.contextWindow,
          reported: contexts.get(entry.sessionId),
          configured: models.get(entry.cwd) ?? null,
        }),
        staleAfterMs: config.staleAfterMs,
        askWindowMs: config.waitingWindowMs,
        taskWindowMs: config.taskWindowMs,
        heldByDriver: held,
        sampled: this.index.isSampled(entry.file),
        transcriptBytes: this.index.sizeOf(entry.file),
        parked: pids.length === 0 && parked.has(entry.sessionId),
      })
      if (drivenWithoutPid) session.livePids = []
      // Seeing a session alive is what earns it a place in the registry later, and driving one
      // is aivis seeing it alive.
      if (pids.length > 0 || drivenWithoutPid) parked.see(session.id, session.cwd, session.title)
      seen.add(session.id)
      const previous = this.sessions.get(session.id)
      if (!previous || !sameDisplayState(previous, session)) changed.push(session)
      this.sessions.set(session.id, session)
    }

    const removed: string[] = []
    for (const id of this.sessions.keys()) {
      if (!seen.has(id)) {
        removed.push(id)
        this.sessions.delete(id)
      }
    }

    // Persist what this scan learned, so the record survives a shutdown that gives no notice.
    void parked.save()

    this.scanned = true
    return { changed, removed }
  }

  /**
   * Bring the git state of this scan's directories up to date, within a budget.
   *
   * A directory nobody has read yet is read outright, because there is nothing to be stale:
   * the alternative is publishing "no branch, not a repository" about a checkout, which the
   * fleet list and the session page both act on. Reading every directory once, at
   * `LOOKUP_CONCURRENCY` at a time, is a cost paid once per directory per run of the daemon,
   * and it is paid after the server is already listening.
   *
   * The budget is on re-reads, which is where the recurring cost lives. A directory something
   * is happening in — a live session, a driven one, a transcript that moved — is re-read as
   * soon as its reading is `GIT_ACTIVE_TTL_MS` old, which is the cadence the whole fleet used
   * to run at. A quiet one is re-read too, just rarely: a few per scan, most recently used
   * first, so that a store with hundreds of directories costs a trickle of `git` processes
   * rather than a wave, and the session you are most likely to open is the one whose counts
   * are freshest.
   */
  private async readGit(dirs: Map<string, { active: boolean; lastActivityAt: string }>): Promise<void> {
    const now = Date.now()
    const due: string[] = []
    const quiet: { cwd: string; lastActivityAt: string }[] = []
    for (const [cwd, dir] of dirs) {
      const readAt = this.gitByCwd.get(cwd)?.readAt
      if (readAt === undefined) due.push(cwd)
      else if (dir.active && now - readAt >= GIT_ACTIVE_TTL_MS) due.push(cwd)
      else if (now - readAt >= GIT_QUIET_TTL_MS) quiet.push({ cwd, lastActivityAt: dir.lastActivityAt })
    }
    quiet.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
    for (const entry of quiet.slice(0, GIT_QUIET_PER_SCAN)) due.push(entry.cwd)

    // `gitState` keeps a cache of its own on the same ten-second clock, and reading through it
    // costs nothing here: a directory only reaches this line once the reading held above has
    // expired, so the two caches never save each other any work. What they do stack is age — a
    // fetch that landed on a nine-second-old entry would be stamped as read now and then held
    // for a full TTL again, leaving a branch or a diff figure up to twice the TTL behind the
    // working tree. Bypassing the inner cache makes the TTLs above the only ones there are, so
    // a reading is exactly as old as this map says it is.
    await pool(due, LOOKUP_CONCURRENCY, async (cwd) => {
      this.gitByCwd.set(cwd, { readAt: Date.now(), state: await gitState(cwd, 0) })
    })

    // Directories no session lives in any more are dropped, so a long run holds one entry per
    // directory in the fleet rather than one per directory it has ever seen.
    for (const cwd of this.gitByCwd.keys()) {
      if (!dirs.has(cwd)) this.gitByCwd.delete(cwd)
    }
  }

  all(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  processes(): Promise<LiveProcess[]> {
    return liveProcesses()
  }
}

/**
 * Run `work` over `items`, no more than `limit` of them at a time.
 *
 * The per-directory lookups shell out to `git` and read settings files, so running them one
 * after another makes a scan as slow as the store is large, while starting them all at once
 * would put one `git` process per project directory on the machine at the same moment. A
 * small fixed number in flight keeps both the wait and the process table bounded.
 */
async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const runner = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      if (item !== undefined) await work(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner))
}

/**
 * Decide which transcripts a set of live processes belongs to.
 *
 * A transcript records its working directory but not the process id that writes it. Where the
 * client has said which session it is running — `server/registry.ts`, and every current
 * version does — that is taken as the answer, and the pid it names is spoken for even if the
 * session it names has no transcript here yet: handing it to a neighbour would be attributing
 * a process to a conversation it is known not to be running.
 *
 * What is left is the guess this had always been. Within each directory the most recently
 * active of the remaining transcripts are matched to the remaining processes, one each, which
 * is right whenever the running sessions are also the recently active ones — and, in a
 * directory with one session in it, right outright. The guess is what a client too old to
 * write a record falls back to, so it stays.
 */
function assignLiveness(
  parsed: { file: string; sessionId: string; cwd: string; lastActivityAt: string }[],
  processes: LiveProcess[],
  registered: Map<string, RegisteredSession> = new Map(),
): Map<string, number[]> {
  const result = new Map<string, number[]>()
  const spokenFor = new Set<number>()
  const attributed = new Set<string>()
  for (const entry of registered.values()) spokenFor.add(entry.pid)
  for (const entry of parsed) {
    const record = registered.get(entry.sessionId)
    if (!record) continue
    result.set(entry.file, [record.pid])
    attributed.add(entry.file)
  }

  const byCwd = new Map<string, { file: string; lastActivityAt: string }[]>()
  for (const entry of parsed) {
    if (attributed.has(entry.file)) continue
    const list = byCwd.get(entry.cwd) ?? []
    list.push({ file: entry.file, lastActivityAt: entry.lastActivityAt })
    byCwd.set(entry.cwd, list)
  }

  const pidsByCwd = new Map<string, number[]>()
  for (const proc of processes) {
    if (spokenFor.has(proc.pid)) continue
    const list = pidsByCwd.get(proc.cwd) ?? []
    list.push(proc.pid)
    pidsByCwd.set(proc.cwd, list)
  }

  for (const [cwd, pids] of pidsByCwd) {
    const candidates = (byCwd.get(cwd) ?? []).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
    candidates.slice(0, pids.length).forEach((candidate, i) => {
      const pid = pids[i]
      if (pid !== undefined) result.set(candidate.file, [pid])
    })
  }
  return result
}

/** Compare the fields the dashboard renders, ignoring ones that churn without effect. */
function sameDisplayState(a: Session, b: Session): boolean {
  return (
    a.status === b.status &&
    a.lastActivityAt === b.lastActivityAt &&
    a.title === b.title &&
    a.toolCalls === b.toolCalls &&
    a.userTurns === b.userTurns &&
    a.tokens.contextWindow === b.tokens.contextWindow &&
    a.contextLimit.tokens === b.contextLimit.tokens &&
    a.git.filesChanged === b.git.filesChanged &&
    a.git.insertions === b.git.insertions &&
    a.git.deletions === b.git.deletions &&
    a.git.branch === b.git.branch &&
    // Whether the directory is a checkout at all, which the session page reads to decide which
    // change bases it can offer. It does not follow from the fields above: a reading the scan
    // has not taken yet, and one whose `git` call failed or timed out, both report the same
    // no-branch, no-changes shape as a directory that genuinely is not a repository, so this
    // answer can flip back without a single figure above it moving.
    a.git.isRepo === b.git.isRepo &&
    a.livePids.join(',') === b.livePids.join(',') &&
    a.lastActivity?.at === b.lastActivity?.at &&
    // Work running outside the turn is the one thing here a session can start and finish
    // without writing anything the comparisons above would notice — a task given up on
    // after its window expires writes nothing at all — so the index would keep drawing a
    // run that had ended.
    a.background.map((task) => task.toolUseId).join(',') ===
      b.background.map((task) => task.toolUseId).join(',') &&
    // The sparkline slides as minutes pass, so a session that has gone quiet keeps
    // reporting until its bars have decayed to nothing and then stops churning.
    a.pulse.join(',') === b.pulse.join(',')
  )
}
