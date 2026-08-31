import { useState } from 'react'
import type { DiffLine, FileDiff } from '../diff.ts'

/**
 * A file edit, rendered as a diff.
 *
 * The transcript records both sides of an edit, so what used to print as a wall of escaped
 * JSON is shown the way an edit is actually read: removals above additions, and within a
 * changed line, the words that moved marked so the eye lands on them instead of scanning a
 * whole line for the difference.
 */
export function DiffView({
  diffs,
  cwd,
  heads = true,
}: {
  diffs: FileDiff[]
  cwd: string
  /**
   * Whether each block names its own file and counts. The files rail turns this off for an
   * edit that made a single diff, because the edit's own header already says both.
   */
  heads?: boolean
}): React.JSX.Element {
  return (
    <div className="diff">
      {diffs.map((diff, index) => (
        <DiffBlock key={`${diff.label}-${index}`} diff={diff} cwd={cwd} head={heads} />
      ))}
    </div>
  )
}

function DiffBlock({
  diff,
  cwd,
  head,
}: {
  diff: FileDiff
  cwd: string
  head: boolean
}): React.JSX.Element {
  const relative = diff.path.startsWith(cwd) ? diff.path.slice(cwd.length + 1) : diff.path
  return (
    <div className="diff__block">
      {head ? (
        <div className="diff__head">
          <span className="diff__label">{diff.label}</span>
          <span className="diff__path" title={diff.path}>
            {relative || diff.path}
          </span>
          <span className="diff__counts">
            {diff.added > 0 ? <span className="diff__plus">+{diff.added}</span> : null}
            {diff.removed > 0 ? <span className="diff__minus">−{diff.removed}</span> : null}
          </span>
        </div>
      ) : null}
      <div className="diff__body">
        {diff.lines.map((line, index) =>
          line.kind === 'fold' ? (
            <Fold key={index} line={line} />
          ) : (
            <Row key={index} line={line} />
          ),
        )}
      </div>
    </div>
  )
}

/** One diff line: its number, its sign, and its text. */
function Row({ line }: { line: DiffLine }): React.JSX.Element {
  const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '
  return (
    <div className={`dl dl--${line.kind}`}>
      <span className="dl__n">{line.n ?? ''}</span>
      <span className="dl__sign">{sign}</span>
      <span className="dl__text">
        {line.parts ? (
          line.parts.map((part, index) =>
            part.changed ? (
              <mark key={index} className="dl__mark">
                {part.text}
              </mark>
            ) : (
              <span key={index}>{part.text}</span>
            ),
          )
        ) : (
          line.text
        )}
        {/* An empty line still needs height, so it gets a zero-width space. */}
        {!line.parts && line.text === '' ? '​' : null}
      </span>
    </div>
  )
}

/** A run of unchanged lines, hidden until asked for. */
function Fold({ line }: { line: DiffLine }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const hidden = line.hidden ?? []
  if (open) {
    return (
      <>
        <button className="dl dl--fold" onClick={() => setOpen(false)}>
          <span className="dl__n" />
          <span className="dl__sign">⌃</span>
          <span className="dl__text">hide {hidden.length} unchanged</span>
        </button>
        {hidden.map((entry, index) => (
          <Row key={index} line={entry} />
        ))}
      </>
    )
  }
  return (
    <button className="dl dl--fold" onClick={() => setOpen(true)}>
      <span className="dl__n" />
      <span className="dl__sign">⋯</span>
      <span className="dl__text">
        {hidden.length} unchanged {hidden.length === 1 ? 'line' : 'lines'}
      </span>
    </button>
  )
}
