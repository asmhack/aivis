/**
 * Diffing for the file-editing tools.
 *
 * A transcript records an edit as its two sides — the text before and the text after — so
 * the diff is computed here from what the tool call already carries. Nothing is fetched and
 * nothing is stored: the same input that used to be dumped as JSON becomes a readable diff.
 */

export type DiffKind = 'add' | 'del' | 'ctx' | 'fold'

/** A run of characters within a line, marked when it is part of what changed. */
export interface DiffPart {
  text: string
  changed: boolean
}

export interface DiffLine {
  kind: DiffKind
  text: string
  /**
   * 1-based line number in the resulting file, when it is knowable. A whole-file write is
   * numbered from one; an edit's position in the file is not recorded in the transcript, so
   * those lines carry no number rather than a guessed one.
   */
  n?: number
  /** Word-level segments, present on a changed line paired with its counterpart. */
  parts?: DiffPart[]
  /** For a `fold`, the unchanged lines it stands in for, kept so it can be opened. */
  hidden?: DiffLine[]
}

export interface FileDiff {
  path: string
  /** What produced this diff, e.g. `Write` or `Edit 2 of 3`. */
  label: string
  lines: DiffLine[]
  added: number
  removed: number
  /** True when the whole file is being written, so every line is new. */
  whole: boolean
}

interface Op {
  kind: 'ctx' | 'del' | 'add'
  ai: number
  bi: number
}

/** Beyond this the quadratic table is too big to be worth building. */
const LCS_CELL_LIMIT = 4_000_000

/**
 * Longest-common-subsequence diff over two sequences.
 *
 * Common head and tail are trimmed first, which is what keeps this fast on real edits: a
 * hundred-line hunk that changes two lines only ever runs the quadratic part on those two.
 */
function diffSequences<T>(a: T[], b: T[], same: (x: T, y: T) => boolean): Op[] {
  const ops: Op[] = []

  let head = 0
  while (head < a.length && head < b.length && same(a[head] as T, b[head] as T)) head += 1

  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    same(a[a.length - 1 - tail] as T, b[b.length - 1 - tail] as T)
  ) {
    tail += 1
  }

  for (let i = 0; i < head; i += 1) ops.push({ kind: 'ctx', ai: i, bi: i })

  const aMid = a.slice(head, a.length - tail)
  const bMid = b.slice(head, b.length - tail)
  const m = aMid.length
  const n = bMid.length

  if (m === 0 || n === 0 || m * n > LCS_CELL_LIMIT) {
    // Nothing in common to find, or too large to search: the middle is a wholesale replace.
    for (let i = 0; i < m; i += 1) ops.push({ kind: 'del', ai: head + i, bi: -1 })
    for (let j = 0; j < n; j += 1) ops.push({ kind: 'add', ai: -1, bi: head + j })
  } else {
    const width = n + 1
    const dp = new Int32Array((m + 1) * width)
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        dp[i * width + j] = same(aMid[i] as T, bMid[j] as T)
          ? (dp[(i + 1) * width + j + 1] as number) + 1
          : Math.max(dp[(i + 1) * width + j] as number, dp[i * width + j + 1] as number)
      }
    }
    let i = 0
    let j = 0
    while (i < m && j < n) {
      if (same(aMid[i] as T, bMid[j] as T)) {
        ops.push({ kind: 'ctx', ai: head + i, bi: head + j })
        i += 1
        j += 1
      } else if ((dp[(i + 1) * width + j] as number) >= (dp[i * width + j + 1] as number)) {
        ops.push({ kind: 'del', ai: head + i, bi: -1 })
        i += 1
      } else {
        ops.push({ kind: 'add', ai: -1, bi: head + j })
        j += 1
      }
    }
    while (i < m) {
      ops.push({ kind: 'del', ai: head + i, bi: -1 })
      i += 1
    }
    while (j < n) {
      ops.push({ kind: 'add', ai: -1, bi: head + j })
      j += 1
    }
  }

  for (let k = 0; k < tail; k += 1) {
    ops.push({ kind: 'ctx', ai: a.length - tail + k, bi: b.length - tail + k })
  }
  return ops
}

/** Split a line into the units a reader compares: words, whitespace, and single symbols. */
function tokenize(line: string): string[] {
  return line.match(/[A-Za-z0-9_$]+|\s+|./g) ?? []
}

/** How much two lines have in common, 0 to 1, used to decide if they are worth pairing. */
function similarity(a: string, b: string): number {
  const at = tokenize(a)
  const bt = tokenize(b)
  if (at.length === 0 && bt.length === 0) return 1
  const pool = new Map<string, number>()
  for (const token of at) pool.set(token, (pool.get(token) ?? 0) + 1)
  let shared = 0
  for (const token of bt) {
    const left = pool.get(token) ?? 0
    if (left > 0) {
      shared += 1
      pool.set(token, left - 1)
    }
  }
  return (2 * shared) / (at.length + bt.length)
}

/** Mark the words that actually differ between two versions of one line. */
function wordParts(before: string, after: string): { del: DiffPart[]; add: DiffPart[] } {
  const at = tokenize(before)
  const bt = tokenize(after)
  const ops = diffSequences(at, bt, (x, y) => x === y)

  const del: DiffPart[] = []
  const add: DiffPart[] = []
  const push = (list: DiffPart[], text: string, changed: boolean): void => {
    const last = list[list.length - 1]
    // Merge neighbours of the same kind so the DOM carries runs, not one span per token.
    if (last && last.changed === changed) last.text += text
    else list.push({ text, changed })
  }

  for (const op of ops) {
    if (op.kind === 'ctx') {
      push(del, at[op.ai] as string, false)
      push(add, bt[op.bi] as string, false)
    } else if (op.kind === 'del') {
      push(del, at[op.ai] as string, true)
    } else {
      push(add, bt[op.bi] as string, true)
    }
  }
  return { del, add }
}

/** Unchanged lines to keep either side of a change before folding the rest away. */
const CONTEXT = 3

/**
 * Fold long unchanged stretches into a single marker.
 *
 * A diff is read for what changed, so more than a few lines of untouched context between
 * two edits is noise. The marker keeps the count, so nothing is silently hidden.
 */
function foldContext(lines: DiffLine[]): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.kind === 'ctx') continue
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j += 1) {
      keep[j] = true
    }
  }

  const out: DiffLine[] = []
  let run: DiffLine[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as DiffLine
    if (keep[i]) {
      if (run.length > 0) {
        out.push({ kind: 'fold', text: '', hidden: run })
        run = []
      }
      out.push(line)
    } else {
      run.push(line)
    }
  }
  if (run.length > 0) out.push({ kind: 'fold', text: '', hidden: run })
  return out
}

/** Whether a paired change is close enough that word-level marks help rather than distract. */
const PAIR_THRESHOLD = 0.3

/**
 * The most of a line that may be marked before the marks are dropped.
 *
 * Word marks earn their place by pointing at a small difference. A line that changed almost
 * entirely — a rewritten sentence, say — would come back nearly all highlighted, which is
 * noise: the `+` and `−` already say the whole line changed.
 */
const MARK_CEILING = 0.5

/** How much of a line the marked runs cover, 0 to 1. */
function markedFraction(parts: DiffPart[]): number {
  let changed = 0
  let total = 0
  for (const part of parts) {
    total += part.text.length
    if (part.changed) changed += part.text.length
  }
  return total === 0 ? 0 : changed / total
}

/**
 * Word-level marks for a removed line and the addition that replaced it, or null when the
 * two are too different to be worth pairing or the marks would cover most of the line.
 *
 * Exported because a diff computed by git arrives as lines with no marks at all, and the
 * same rules should decide what gets highlighted there.
 */
export function pairParts(before: string, after: string): { del: DiffPart[]; add: DiffPart[] } | null {
  if (similarity(before, after) < PAIR_THRESHOLD) return null
  const mark = wordParts(before, after)
  if (markedFraction(mark.del) > MARK_CEILING || markedFraction(mark.add) > MARK_CEILING) return null
  return mark
}

/**
 * Split one side into the lines a diff is about.
 *
 * An empty string is zero lines rather than one line that happens to be empty, and a
 * trailing newline terminates the last line rather than starting a new empty one, which is
 * what `diff` and `git diff` mean by it. Trusting `split` alone counted that phantom element
 * as a real line, so every file ending in a newline — nearly all of them — reported one line
 * too many and drew a blank green line under the last real one. Only one trailing element is
 * dropped, so a file that genuinely ends in a blank line still shows it.
 */
function toLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Build the rendered line list for one before/after pair. */
function buildLines(before: string, after: string, numbered: boolean): DiffLine[] {
  const a = toLines(before)
  const b = toLines(after)
  const ops = diffSequences(a, b, (x, y) => x === y)

  const lines: DiffLine[] = []
  let index = 0
  while (index < ops.length) {
    const op = ops[index] as Op
    if (op.kind === 'ctx') {
      lines.push({ kind: 'ctx', text: a[op.ai] as string, ...(numbered ? { n: op.bi + 1 } : {}) })
      index += 1
      continue
    }

    // Gather the deletions and the additions that sit together, so they can be paired.
    const dels: Op[] = []
    while (index < ops.length && (ops[index] as Op).kind === 'del') dels.push(ops[index++] as Op)
    const adds: Op[] = []
    while (index < ops.length && (ops[index] as Op).kind === 'add') adds.push(ops[index++] as Op)

    const paired = Math.min(dels.length, adds.length)
    const marks = new Array<{ del: DiffPart[]; add: DiffPart[] } | null>(paired).fill(null)
    for (let k = 0; k < paired; k += 1) {
      marks[k] = pairParts(a[(dels[k] as Op).ai] as string, b[(adds[k] as Op).bi] as string)
    }

    dels.forEach((entry, k) => {
      const mark = k < paired ? marks[k] : null
      lines.push({ kind: 'del', text: a[entry.ai] as string, ...(mark ? { parts: mark.del } : {}) })
    })
    adds.forEach((entry, k) => {
      const mark = k < paired ? marks[k] : null
      lines.push({
        kind: 'add',
        text: b[entry.bi] as string,
        ...(numbered ? { n: entry.bi + 1 } : {}),
        ...(mark ? { parts: mark.add } : {}),
      })
    })
  }
  return lines
}

function count(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.kind === 'add') added += 1
    else if (line.kind === 'del') removed += 1
  }
  return { added, removed }
}

function makeDiff(path: string, label: string, before: string, after: string, whole: boolean): FileDiff {
  // A whole-file write is numbered from one, which is exactly right. An edit's offset in the
  // file is not in the transcript, so its lines are left unnumbered rather than mislabelled.
  const lines = foldContext(buildLines(before, after, whole))
  return { path, label, lines, whole, ...count(lines) }
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * Turn a file-editing tool call into the diffs it represents, or null when the tool does
 * not edit a file and should keep its ordinary rendering.
 */
export function toolDiffs(name: string, input: Record<string, unknown>): FileDiff[] | null {
  const path =
    str(input.file_path) ?? str(input.filePath) ?? str(input.notebook_path) ?? str(input.path) ?? ''

  if (name === 'Write') {
    const content = str(input.content)
    if (content === null) return null
    return [makeDiff(path, 'Write', '', content, true)]
  }

  if (name === 'Edit') {
    const before = str(input.old_string)
    const after = str(input.new_string)
    if (before === null || after === null) return null
    const all = input.replace_all === true
    return [makeDiff(path, all ? 'Edit · all occurrences' : 'Edit', before, after, false)]
  }

  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const edits = input.edits as Record<string, unknown>[]
    const out: FileDiff[] = []
    edits.forEach((edit, index) => {
      const before = str(edit.old_string)
      const after = str(edit.new_string)
      if (before === null || after === null) return
      out.push(makeDiff(path, `Edit ${index + 1} of ${edits.length}`, before, after, false))
    })
    return out.length > 0 ? out : null
  }

  if (name === 'NotebookEdit') {
    const after = str(input.new_source)
    if (after === null) return null
    const before = str(input.old_source) ?? ''
    return [makeDiff(path, 'Notebook edit', before, after, before === '')]
  }

  return null
}
