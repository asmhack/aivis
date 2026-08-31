import { Fragment, useEffect, useMemo, useState } from 'react'
import type {
  ChangeBase,
  ChangeSet,
  ChangeStatus,
  ChangedFile,
  FileChange,
  HunkLine,
} from '../../shared/types.ts'
import { age } from '../format.ts'
import { pairParts, type DiffPart } from '../diff.ts'
import { useDockedSelection } from '../useDockedSelection.ts'
import { DiffView } from './DiffView.tsx'
import type { TouchedFile } from '../changes.ts'

/**
 * Where the files view is pointing.
 *
 * Two levels, like the agents tab: the list answers what the session touched, and one file
 * answers what exactly changed in it and which tool call did it.
 */
export type ChangesView = { level: 'list' } | { level: 'file'; path: string }

/** One row of the file list, from either the git bases or the session's own edits. */
interface Row {
  /** Path relative to the session's working directory. */
  path: string
  status: ChangeStatus
  added: number
  removed: number
  oldPath: string | null
  similarity: number | null
  binary: boolean
  untracked: boolean
}

const LETTER: Record<ChangeStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
}

const MARK: Record<ChangeStatus, string> = {
  added: 'a',
  modified: 'm',
  deleted: 'd',
  renamed: 'r',
}

const BASE_LABEL: Record<ChangeBase, string> = {
  start: 'vs session start',
  head: 'uncommitted',
  session: "this session's edits",
}

function fromGit(files: ChangedFile[]): Row[] {
  return files.map((file) => ({ ...file }))
}

/**
 * The session's own edits as rows.
 *
 * Only `added` and `modified` can appear: the file-editing tools never delete or rename,
 * so a status this base cannot know is a status it does not claim.
 */
function fromSession(touched: TouchedFile[]): Row[] {
  return touched.map((file) => ({
    path: file.rel,
    status: file.created ? 'added' : 'modified',
    added: file.added,
    removed: file.removed,
    oldPath: null,
    similarity: null,
    binary: false,
    untracked: false,
  }))
}

function dirOf(file: string): string {
  const at = file.lastIndexOf('/')
  return at < 0 ? 'root' : file.slice(0, at)
}

function nameOf(file: string): string {
  const at = file.lastIndexOf('/')
  return at < 0 ? file : file.slice(at + 1)
}

/**
 * Group rows by the directory they live in, busiest directory first.
 *
 * Where the work happened is the first thing the list should say, and churn is the only
 * honest measure of that — alphabetical order would bury a rewritten module under a
 * config file. Both the full list and the docked list group this way, so a file sits in
 * the same place in each.
 */
function byDirectory(rows: Row[]): [string, Row[]][] {
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const dir = dirOf(row.path)
    const list = groups.get(dir)
    if (list) list.push(row)
    else groups.set(dir, [row])
  }
  const churn = (list: Row[]): number => list.reduce((sum, row) => sum + row.added + row.removed, 0)
  return [...groups.entries()].sort(
    (a, b) => churn(b[1]) - churn(a[1]) || a[0].localeCompare(b[0]),
  )
}

/**
 * Five cells standing for the size and shape of a change.
 *
 * The scale is logarithmic against the biggest change in the list, because a 400-line
 * rewrite beside a 3-line tweak would otherwise leave every small file looking identical.
 * The cells split between additions and removals by their share, and a side that changed
 * anything at all always keeps one cell, so a deletion never disappears into rounding.
 */
function Spark({ row, max }: { row: Row; max: number }): React.JSX.Element {
  const total = row.added + row.removed
  const filled =
    total === 0 ? 0 : Math.max(1, Math.round((5 * Math.log1p(total)) / Math.log1p(Math.max(max, total))))

  let adds = total === 0 ? 0 : Math.round((filled * row.added) / total)
  if (row.added > 0 && adds === 0) adds = 1
  if (row.removed > 0 && adds === filled) adds = filled - 1
  const dels = filled - adds

  return (
    <span className="spark">
      {[0, 1, 2, 3, 4].map((cell) => (
        <i key={cell} className={cell < adds ? 'is-add' : cell < adds + dels ? 'is-del' : ''} />
      ))}
    </span>
  )
}

function Counts({ added, removed }: { added: number; removed: number }): React.JSX.Element {
  return (
    <>
      {added > 0 ? <span className="add">+{added}</span> : null}
      {added > 0 && removed > 0 ? ' ' : null}
      {removed > 0 ? <span className="del">−{removed}</span> : null}
      {added === 0 && removed === 0 ? <span className="frow__quiet">—</span> : null}
    </>
  )
}

/** The files tab: what the session changed, and then one of those files. */
export function ChangesRail({
  sessionId,
  cwd,
  base,
  onBase,
  bases,
  changes,
  touched,
  view,
  onView,
  partial,
  onLoadMore,
  onReveal,
}: {
  sessionId: string
  cwd: string
  base: ChangeBase
  onBase: (base: ChangeBase) => void
  /** Which bases this session can offer; a directory outside git has only its own edits. */
  bases: ChangeBase[]
  changes: ChangeSet | null
  touched: TouchedFile[]
  view: ChangesView
  onView: (view: ChangesView) => void
  partial: boolean
  onLoadMore: () => void
  /** Open a tool call back in the conversation. */
  onReveal: (callId: string) => void
}): React.JSX.Element {
  const rows = useMemo(
    () => (base === 'session' ? fromSession(touched) : fromGit(changes?.files ?? [])),
    [base, touched, changes],
  )

  if (view.level === 'file') {
    const row = rows.find((entry) => entry.path === view.path)
    return (
      <FileDock rows={rows} path={view.path} onOpen={(path) => onView({ level: 'file', path })}>
        <FileDetail
          sessionId={sessionId}
          cwd={cwd}
          base={base}
          row={row}
          touched={touched.find((file) => file.rel === view.path)}
          onReveal={onReveal}
        />
      </FileDock>
    )
  }

  return (
    <FileList
      base={base}
      onBase={onBase}
      bases={bases}
      changes={changes}
      rows={rows}
      touched={touched}
      onOpen={(file) => onView({ level: 'file', path: file })}
      partial={partial}
      onLoadMore={onLoadMore}
    />
  )
}

/** Level one: the summary, the filters, and the files grouped by directory. */
function FileList({
  base,
  onBase,
  bases,
  changes,
  rows,
  touched,
  onOpen,
  partial,
  onLoadMore,
}: {
  base: ChangeBase
  onBase: (base: ChangeBase) => void
  bases: ChangeBase[]
  changes: ChangeSet | null
  rows: Row[]
  touched: TouchedFile[]
  onOpen: (path: string) => void
  partial: boolean
  onLoadMore: () => void
}): React.JSX.Element {
  const [only, setOnly] = useState<ChangeStatus | null>(null)
  const [find, setFind] = useState('')

  const counts: Record<ChangeStatus, number> = { added: 0, modified: 0, deleted: 0, renamed: 0 }
  for (const row of rows) counts[row.status] += 1

  const needle = find.trim().toLowerCase()
  const shown = rows.filter(
    (row) =>
      (only === null || row.status === only) &&
      (needle === '' || row.path.toLowerCase().includes(needle)),
  )

  const added = shown.reduce((sum, row) => sum + row.added, 0)
  const removed = shown.reduce((sum, row) => sum + row.removed, 0)
  const max = rows.reduce((most, row) => Math.max(most, row.added + row.removed), 1)

  const ordered = byDirectory(shown)

  const chip = (label: string, status: ChangeStatus | null, count: number): React.JSX.Element | null =>
    count === 0 && status !== null ? null : (
      <button
        className={`chip ${only === status ? 'chip--on' : ''} ${status === 'deleted' ? 'chip--del' : ''}`}
        onClick={() => setOnly(status)}
      >
        {label} {count}
      </button>
    )

  return (
    <div className="changes">
      <div className="sum">
        <div className="sum__head">
          <span className="sum__n">
            {shown.length} {shown.length === 1 ? 'file' : 'files'}
          </span>
          <span className="sum__diff">
            <Counts added={added} removed={removed} />
          </span>
          <select
            className="sum__base"
            value={base}
            onChange={(event) => onBase(event.target.value as ChangeBase)}
            title="What the change list is measured against"
          >
            {bases.map((option) => (
              <option key={option} value={option}>
                {BASE_LABEL[option]}
              </option>
            ))}
          </select>
        </div>
        <BaseNote base={base} changes={changes} touched={touched} />
        <p className="sum__legend">
          {(['added', 'modified', 'deleted', 'renamed'] as ChangeStatus[]).map((status) => (
            <span key={status}>
              <b className={`st st--${MARK[status]}`}>{LETTER[status]}</b> {status}
            </span>
          ))}
        </p>
      </div>

      <div className="filters">
        {chip('all', null, rows.length)}
        {chip('added', 'added', counts.added)}
        {chip('modified', 'modified', counts.modified)}
        {chip('deleted', 'deleted', counts.deleted)}
        {chip('renamed', 'renamed', counts.renamed)}
        <input
          className="filters__find"
          placeholder="filter path…"
          value={find}
          onChange={(event) => setFind(event.target.value)}
        />
      </div>

      {base === 'session' && partial ? (
        <div className="rail__note">
          <p>
            These are the files edited in the part of the conversation that is loaded, so a
            file changed earlier is not listed yet.
          </p>
          <button className="loadmore" onClick={onLoadMore}>
            load more history
          </button>
        </div>
      ) : null}

      {shown.length === 0 ? (
        <p className="note">
          {rows.length > 0 ? 'No file matches that filter.' : emptyNote(base, changes)}
        </p>
      ) : null}

      {ordered.map(([dir, list]) => (
        <div className="dirgroup" key={dir}>
          <p className="dirgroup__head">
            <b>{dir}</b> · {list.length} {list.length === 1 ? 'file' : 'files'}
          </p>
          <div className="flist">
            {list.map((row) => (
              <button className="frow" key={row.path} onClick={() => onOpen(row.path)}>
                <span className={`st st--${MARK[row.status]}`} title={row.status}>
                  {LETTER[row.status]}
                </span>
                <span className="frow__name" title={row.path}>
                  {nameOf(row.path)}
                  {row.oldPath ? <em> ← {nameOf(row.oldPath)}</em> : null}
                </span>
                {row.similarity !== null ? (
                  <span className="frow__tag">{row.similarity}% same</span>
                ) : row.binary ? (
                  <span className="frow__tag">binary</span>
                ) : (
                  <span />
                )}
                <span className="frow__nums">
                  <Counts added={row.added} removed={row.removed} />
                </span>
                <Spark row={row} max={max} />
                <span className="frow__go">›</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * Every changed file beside the diff of the one being read.
 *
 * Reviewing a session's work means walking its files in order, and a diff read one file at
 * a time through the back arrow makes that walk cost two clicks a file. The list stays
 * docked so it costs one, and so the file being read is always visible in the context of
 * the rest. It carries no filters — the filtered list is the level above, and a docked
 * list that hid files would make "next file" mean something different here than there.
 */
function FileDock({
  rows,
  path,
  onOpen,
  children,
}: {
  rows: Row[]
  path: string
  onOpen: (path: string) => void
  children: React.ReactNode
}): React.JSX.Element {
  const ordered = useMemo(() => byDirectory(rows), [rows])
  const selected = useDockedSelection(path)

  return (
    <div className="split">
      <nav className="split__list" aria-label="Changed files">
        {ordered.map(([dir, list]) => (
          <Fragment key={dir}>
            <p className="split__group" title={dir}>
              {dir} · {list.length}
            </p>
            {list.map((row) => (
              <button
                key={row.path}
                ref={row.path === path ? selected : undefined}
                className={`li ${row.path === path ? 'li--on' : ''}`}
                onClick={() => onOpen(row.path)}
                title={row.path}
              >
                <span className={`st st--${MARK[row.status]}`} aria-label={row.status}>
                  {LETTER[row.status]}
                </span>
                <span className="li__name li__name--mono">{nameOf(row.path)}</span>
              </button>
            ))}
          </Fragment>
        ))}
      </nav>
      <div className="split__detail">{children}</div>
    </div>
  )
}

/**
 * What an empty list says, which is three different things.
 *
 * The third is the one worth spelling out. A `start` list can come back empty in a tree
 * that is visibly dirty, because the files that differ from the base were all written
 * before the session began — so the sentence says where they went rather than leaving the
 * list looking broken.
 */
function emptyNote(base: ChangeBase, changes: ChangeSet | null): string {
  if (base === 'session') return 'This session has not edited a file yet.'
  const older = base === 'start' ? (changes?.predating ?? 0) : 0
  if (older === 0) return 'Nothing differs from the base.'
  const differ = older === 1 ? '1 file differs' : `${older} files differ`
  return (
    `Nothing has changed since this session started. ${differ} from the base, ` +
    `last written before it began — switch to uncommitted to see ${older === 1 ? 'it' : 'them'}.`
  )
}

/** The one line that says exactly what "changed" is being measured against. */
function BaseNote({
  base,
  changes,
  touched,
}: {
  base: ChangeBase
  changes: ChangeSet | null
  touched: TouchedFile[]
}): React.JSX.Element {
  if (base === 'session') {
    const calls = touched.reduce((sum, file) => sum + file.edits.length, 0)
    return (
      <p className="sum__note">
        every file the session wrote to · <b>{calls}</b> {calls === 1 ? 'tool call' : 'tool calls'} ·
        a file changed outside a tool call is not here
      </p>
    )
  }
  if (!changes) return <p className="sum__note">reading the working tree…</p>
  if (!changes.isRepo) {
    return <p className="sum__note">this directory is not a git repository</p>
  }
  if (changes.error) return <p className="sum__note">git could not read the tree: {changes.error}</p>
  if (!changes.baseCommit) {
    return <p className="sum__note">this repository has no commit yet — everything here is new</p>
  }
  return (
    <p className="sum__note">
      since <b>{changes.baseCommit}</b>
      {changes.baseAt ? ` · ${age(changes.baseAt)} ago` : ''}
      {changes.branch ? ` · ${changes.branch}` : ''}
      {changes.baseFellBack
        ? ' · no commit predates this session, so this is the uncommitted work'
        : ''}
      {changes.predating > 0
        ? ` · ${changes.predating} older ${changes.predating === 1 ? 'file' : 'files'} left out`
        : ''}
      {changes.untrackedCapped ? ' · too many new files to list them all' : ''}
    </p>
  )
}

/** Level two: one file, its hunks, and the tool calls that wrote them. */
function FileDetail({
  sessionId,
  cwd,
  base,
  row,
  touched,
  onReveal,
}: {
  sessionId: string
  cwd: string
  base: ChangeBase
  row: Row | undefined
  touched: TouchedFile | undefined
  onReveal: (callId: string) => void
}): React.JSX.Element {
  if (!row) return <p className="note">That file is no longer in the list.</p>

  return (
    <div className="changes">
      <div className="fhead">
        <div className="fhead__top">
          <span className={`st st--${MARK[row.status]}`}>{LETTER[row.status]}</span>
          <span className="fhead__path" title={row.path}>
            <i>{row.path}</i>
          </span>
          <span className="fhead__nums">
            <Counts added={row.added} removed={row.removed} />
          </span>
        </div>
        <div className="fhead__meta">
          {row.oldPath ? (
            <span>
              renamed from <b>{row.oldPath}</b>
            </span>
          ) : null}
          {row.untracked ? <span>not yet tracked by git</span> : null}
          {touched ? (
            <span>
              edited <b>{touched.edits.length}×</b> by this session
            </span>
          ) : base !== 'session' ? (
            <span>no tool call in the loaded conversation wrote this</span>
          ) : null}
          {touched ? (
            <span>
              last <b>{age(touched.lastAt)} ago</b>
            </span>
          ) : null}
        </div>
      </div>

      {/*
        Under a git base the edits are a companion to git's diff rather than a replacement
        for it: git says what the file adds up to, and these say which call did which part.
      */}
      {touched && touched.edits.length > 0 ? (
        <SessionEdits
          key={touched.path}
          touched={touched}
          cwd={cwd}
          onReveal={onReveal}
          whole={base === 'session'}
        />
      ) : null}

      {base === 'session' && !touched?.edits.length ? (
        <p className="note">This file has no recorded edit in the loaded conversation.</p>
      ) : null}

      {base === 'session' ? null : (
        <GitDiff key={`${base}-${row.path}`} sessionId={sessionId} base={base} path={row.path} />
      )}
    </div>
  )
}

/**
 * The session's edits to one file, each behind its own header.
 *
 * The header is the edit: which call made it, what it did, how much it moved, and how long
 * ago. Opening one shows that call's diff directly underneath it. The two used to be
 * separate — a list of edits, and then every diff in full below it — which said each edit
 * twice and buried a file edited eight times under its own history before you could read
 * any of it.
 *
 */
function SessionEdits({
  touched,
  cwd,
  onReveal,
  whole,
}: {
  touched: TouchedFile
  cwd: string
  onReveal: (callId: string) => void
  /** True when these edits are the file's whole diff rather than a companion to git's. */
  whole: boolean
}): React.JSX.Element {
  // A file touched once has nothing to choose between, so its diff opens with it — unless
  // git's own diff of the file sits below, where that would only say the same thing twice.
  const [open, setOpen] = useState<Set<string>>(
    () =>
      new Set(whole && touched.edits.length === 1 ? touched.edits.map((edit) => edit.callId) : []),
  )

  const toggle = (callId: string): void =>
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(callId)) next.add(callId)
      return next
    })

  return (
    <div className="edits">
      {touched.edits.map((edit, index) => {
        const shown = open.has(edit.callId)
        return (
          <div className={`edit ${shown ? 'edit--on' : ''}`} key={`${edit.callId}-${index}`}>
            {/*
              One click answers both halves of the question: the diff opens here, and the
              conversation moves to the call that wrote it. They are two views of the same
              edit, so making them two clicks only ever meant doing the same thing twice.
            */}
            <button
              className="edit__head"
              onClick={() => {
                toggle(edit.callId)
                onReveal(edit.callId)
              }}
              aria-expanded={shown}
              title="Open this diff and show the tool call in the conversation"
            >
              <span className="edit__mark">{shown ? '▾' : '▸'}</span>
              <span className="edit__n">#{index + 1}</span>
              <span className="edit__what">
                <span className="edit__tool">{edit.tool}</span>
                {edit.label === edit.tool ? '' : ` ${edit.label}`}
              </span>
              <span className="edit__nums">
                <Counts added={edit.added} removed={edit.removed} />
              </span>
              <span className="edit__t">{age(edit.at)}</span>
              <span className="edit__go">↗</span>
            </button>
            {/* One diff needs no heading of its own: the edit's header already named it. */}
            {shown ? (
              <DiffView diffs={edit.diffs} cwd={cwd} heads={edit.diffs.length > 1} />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/** The unified diff of one file, as git computes it. */
function GitDiff({
  sessionId,
  base,
  path,
}: {
  sessionId: string
  base: ChangeBase
  path: string
}): React.JSX.Element {
  const [detail, setDetail] = useState<FileChange | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [context, setContext] = useState(3)
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false)

  useEffect(() => {
    let stopped = false
    const query = new URLSearchParams({
      base,
      path,
      context: String(context),
      ...(ignoreWhitespace ? { whitespace: 'ignore' } : {}),
    })
    void (async () => {
      try {
        const response = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/changes/file?${query.toString()}`,
        )
        if (!response.ok) throw new Error(`server returned ${response.status}`)
        const body = (await response.json()) as FileChange
        if (!stopped) {
          setDetail(body)
          setError(body.error)
        }
      } catch (err) {
        if (!stopped) setError(String(err))
      }
    })()
    return () => {
      stopped = true
    }
  }, [sessionId, base, path, context, ignoreWhitespace])

  return (
    <>
      <div className="fhead__acts">
        <button
          className="act"
          onClick={() => setContext((current) => (current >= 40 ? 3 : current >= 12 ? 40 : 12))}
          title="How many unchanged lines to keep around each change"
        >
          {context} lines context
        </button>
        <button
          className={`act ${ignoreWhitespace ? 'act--on' : ''}`}
          onClick={() => setIgnoreWhitespace((current) => !current)}
        >
          ignore whitespace
        </button>
        <button className="act" onClick={() => void navigator.clipboard.writeText(path)}>
          copy path
        </button>
      </div>

      {error ? <p className="note">Could not read the diff: {error}</p> : null}
      {detail === null && !error ? <p className="note">reading the diff…</p> : null}
      {detail?.binary ? <p className="note">binary file — there are no lines to show</p> : null}
      {detail && !detail.binary && detail.hunks.length === 0 && !error ? (
        <p className="note">
          {ignoreWhitespace ? 'nothing but whitespace changed' : 'no textual change against this base'}
        </p>
      ) : null}

      {detail && detail.hunks.length > 0 ? (
        <div className="diff diff--git">
          {detail.hunks.map((hunk, index) => (
            <Hunk key={`${hunk.header}-${index}`} hunk={hunk} />
          ))}
          {detail.truncated ? (
            <p className="note note--inhunk">
              this diff is too large to show whole — the rest is cut off
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

/** One `@@` block, with the words that moved marked inside changed lines. */
function Hunk({ hunk }: { hunk: { header: string; context: string; lines: HunkLine[]; added: number; removed: number } }): React.JSX.Element {
  const marked = useMemo(() => markPairs(hunk.lines), [hunk])

  return (
    <div className="hunk">
      <div className="hunk__head">
        <span className="hunk__at">{hunk.header}</span>
        <span className="hunk__ctx">{hunk.context}</span>
        <span className="hunk__n">
          <Counts added={hunk.added} removed={hunk.removed} />
        </span>
      </div>
      {marked.map((entry, index) => (
        <div key={index} className={`dline dline--${entry.line.kind}`}>
          <span className="dline__no">{entry.line.oldN ?? ''}</span>
          <span className="dline__no">{entry.line.newN ?? ''}</span>
          <span className="dline__sign">
            {entry.line.kind === 'add' ? '+' : entry.line.kind === 'del' ? '−' : ' '}
          </span>
          <span className="dline__code">
            {entry.parts
              ? entry.parts.map((part, at) =>
                  part.changed ? (
                    <mark key={at} className="dl__mark">
                      {part.text}
                    </mark>
                  ) : (
                    <span key={at}>{part.text}</span>
                  ),
                )
              : entry.line.text}
            {/* An empty line still needs height, so it gets a zero-width space. */}
            {entry.line.text === '' ? '​' : null}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * Pair each removal in a hunk with the addition that replaced it, and mark the words that
 * moved — the same rule the transcript diffs use, applied to lines git produced.
 */
function markPairs(lines: HunkLine[]): { line: HunkLine; parts: DiffPart[] | null }[] {
  const out: { line: HunkLine; parts: DiffPart[] | null }[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] as HunkLine
    if (line.kind !== 'del') {
      out.push({ line, parts: null })
      index += 1
      continue
    }

    const dels: HunkLine[] = []
    while (index < lines.length && (lines[index] as HunkLine).kind === 'del') {
      dels.push(lines[index] as HunkLine)
      index += 1
    }
    const adds: HunkLine[] = []
    while (index < lines.length && (lines[index] as HunkLine).kind === 'add') {
      adds.push(lines[index] as HunkLine)
      index += 1
    }

    const paired = Math.min(dels.length, adds.length)
    const marks = Array.from({ length: paired }, (_, k) =>
      pairParts((dels[k] as HunkLine).text, (adds[k] as HunkLine).text),
    )
    dels.forEach((entry, k) => out.push({ line: entry, parts: marks[k]?.del ?? null }))
    adds.forEach((entry, k) => out.push({ line: entry, parts: marks[k]?.add ?? null }))
  }

  return out
}

/** Breadcrumb trail for the files tab. */
export function ChangesCrumbs({
  view,
  onView,
  count,
}: {
  view: ChangesView
  onView: (view: ChangesView) => void
  count: number
}): React.JSX.Element {
  return (
    <div className="crumbs">
      <button
        className="crumbs__back"
        onClick={() => onView({ level: 'list' })}
        disabled={view.level === 'list'}
        aria-label="Back to the file list"
      >
        ‹
      </button>
      {/*
        The open file is the docked list's selection, and its full path already heads the
        diff, so the trail keeps saying what the whole set is rather than repeating it.
      */}
      <div className="crumbs__path">
        <span className="crumbs__now">
          changes · {count} {count === 1 ? 'file' : 'files'}
        </span>
      </div>
    </div>
  )
}
