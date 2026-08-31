/**
 * Tests for the hand-written diff in `web/diff.ts`.
 *
 * A diff is the one piece of this front end that can be wrong without anything going bang:
 * a mis-aligned hunk renders as a perfectly plausible list of green and red lines that is
 * simply not what changed. So the tests below lean on two kinds of check. Concrete cases
 * pin down the decisions the file's own comments call out — head/tail trimming, the pairing
 * threshold, the mark ceiling, run merging, folding, line numbering. An exhaustive property
 * check over a two-symbol alphabet then covers the alignment itself, because the way a diff
 * usually goes wrong in practice is on repeated lines, and a two-symbol alphabet is nothing
 * but repeated lines.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toolDiffs, pairParts, type DiffLine, type FileDiff } from '../web/diff.ts'

/** The diff of an `Edit`: two sides of a hunk, with no line numbers. */
function editDiff(before: string, after: string): FileDiff {
  const diffs = toolDiffs('Edit', { file_path: '/tmp/f.ts', old_string: before, new_string: after })
  assert.ok(diffs !== null && diffs.length === 1, 'an Edit with two string sides produces one diff')
  return diffs[0] as FileDiff
}

/** The diff of a whole-file `Write`: every line new, numbered from one. */
function writeDiff(content: string): FileDiff {
  const diffs = toolDiffs('Write', { file_path: '/tmp/f.ts', content })
  assert.ok(diffs !== null && diffs.length === 1, 'a Write with string content produces one diff')
  return diffs[0] as FileDiff
}

/** Open every fold, so a test can talk about the diff as the flat list of lines it stands for. */
function flatten(lines: DiffLine[]): DiffLine[] {
  return lines.flatMap((line) => (line.kind === 'fold' ? (line.hidden ?? []) : [line]))
}

const kindsOf = (lines: DiffLine[]): string[] => lines.map((line) => line.kind)
const textsOf = (lines: DiffLine[], kind: string): string[] =>
  lines.filter((line) => line.kind === kind).map((line) => line.text)

// ---------------------------------------------------------------------------
// The trivial cases, which must not be clever.
// ---------------------------------------------------------------------------

test('two identical texts produce a diff that adds and removes nothing, and keeps every line as context', () => {
  const diff = editDiff('alpha\nbeta\ngamma', 'alpha\nbeta\ngamma')

  assert.equal(diff.added, 0)
  assert.equal(diff.removed, 0)

  // With no change anywhere there is no line worth keeping in view, so the whole thing folds
  // into one marker. The marker still carries the lines, because the fold comment promises
  // that nothing is silently hidden.
  assert.deepEqual(kindsOf(diff.lines), ['fold'])
  const hidden = flatten(diff.lines)
  assert.deepEqual(kindsOf(hidden), ['ctx', 'ctx', 'ctx'])
  assert.deepEqual(
    hidden.map((line) => line.text),
    ['alpha', 'beta', 'gamma'],
  )
})

test('an empty before side makes every line an addition and nothing a deletion', () => {
  const diff = editDiff('', 'alpha\nbeta')

  assert.equal(diff.added, 2)
  assert.equal(diff.removed, 0)
  assert.deepEqual(kindsOf(diff.lines), ['add', 'add'])
  assert.deepEqual(textsOf(diff.lines, 'add'), ['alpha', 'beta'])
})

test('an empty after side makes every line a deletion and nothing an addition', () => {
  const diff = editDiff('alpha\nbeta', '')

  assert.equal(diff.added, 0)
  assert.equal(diff.removed, 2)
  assert.deepEqual(kindsOf(diff.lines), ['del', 'del'])
  assert.deepEqual(textsOf(diff.lines, 'del'), ['alpha', 'beta'])
})

test('two empty sides produce no lines at all, rather than one empty line on each side', () => {
  // An empty string is zero lines, not one line that happens to be empty, which is why
  // `buildLines` special-cases the empty string instead of trusting `split`.
  const diff = editDiff('', '')

  assert.deepEqual(diff.lines, [])
  assert.equal(diff.added, 0)
  assert.equal(diff.removed, 0)
})

// ---------------------------------------------------------------------------
// Alignment: what the diff decides is context and what it decides changed.
// ---------------------------------------------------------------------------

const THREE_FUNCTIONS = [
  'function one() {',
  '  return 1',
  '}',
  '',
  'function three() {',
  '  return 3',
  '}',
].join('\n')

test('a block inserted in the middle is reported as additions only, leaving the lines around it as context', () => {
  const after = [
    'function one() {',
    '  return 1',
    '}',
    '',
    'function two() {',
    '  return 2',
    '}',
    '',
    'function three() {',
    '  return 3',
    '}',
  ].join('\n')
  const diff = editDiff(THREE_FUNCTIONS, after)

  // Every original line still exists in the new text, so a correct diff removes nothing and
  // adds exactly the four lines of the new function. A diff that mis-aligned the repeated
  // `}` and blank lines would still add four lines, but it would also delete some.
  assert.equal(diff.removed, 0)
  assert.equal(diff.added, 4)
  assert.deepEqual(textsOf(diff.lines, 'add'), ['function two() {', '  return 2', '}', ''])

  const lines = flatten(diff.lines)
  assert.deepEqual(
    kindsOf(lines),
    ['ctx', 'ctx', 'ctx', 'ctx', 'add', 'add', 'add', 'add', 'ctx', 'ctx', 'ctx'],
    'the insertion sits between the untouched lines rather than rewriting them',
  )
})

test('a block deleted from the middle is reported as deletions only, leaving the lines around it as context', () => {
  const before = [
    'function one() {',
    '  return 1',
    '}',
    '',
    'function two() {',
    '  return 2',
    '}',
    '',
    'function three() {',
    '  return 3',
    '}',
  ].join('\n')
  const diff = editDiff(before, THREE_FUNCTIONS)

  assert.equal(diff.added, 0)
  assert.equal(diff.removed, 4)
  assert.deepEqual(textsOf(diff.lines, 'del'), ['function two() {', '  return 2', '}', ''])
})

test('a modified line is modelled as a deletion followed by an addition, never as one changed line', () => {
  // There is no `mod` kind: the model is strictly add / del / ctx / fold, and word-level
  // marks are what tie the two halves of a modification together.
  const diff = editDiff('alpha\nbeta\ngamma', 'alpha\nBETA\ngamma')

  const lines = flatten(diff.lines)
  assert.deepEqual(kindsOf(lines), ['ctx', 'del', 'add', 'ctx'])
  assert.equal(lines[1]?.text, 'beta')
  assert.equal(lines[2]?.text, 'BETA')
  assert.equal(diff.added, 1)
  assert.equal(diff.removed, 1)
})

test('a deletion is emitted before the addition it is paired with, so the hunk reads minus then plus', () => {
  // `buildLines` gathers a run of deletions and then a run of additions and pairs them by
  // position. That pairing only lines up if the underlying op stream never puts an addition
  // immediately before a deletion, which the tie-break in the backtrack is what guarantees.
  const before = ['keep', 'one', 'two', 'tail'].join('\n')
  const after = ['keep', 'ONE', 'TWO', 'tail'].join('\n')

  assert.deepEqual(kindsOf(flatten(editDiff(before, after).lines)), [
    'ctx',
    'del',
    'del',
    'add',
    'add',
    'ctx',
  ])
})

// ---------------------------------------------------------------------------
// The cases a bad diff gets wrong: repeated lines and moved blocks.
// ---------------------------------------------------------------------------

test('a block appended to a file that already ends in a closing brace does not steal the old closing brace', () => {
  // The hazard: the new text ends with `}` and so does the old one, so a diff that matched
  // from the end would pair the new function's brace with the old function's brace and then
  // report the old body as deleted. Trimming the common head first is what prevents it.
  const before = ['function one() {', '  return 1', '}'].join('\n')
  const after = [...before.split('\n'), '', 'function two() {', '  return 2', '}'].join('\n')
  const diff = editDiff(before, after)

  assert.equal(diff.removed, 0, 'appending changes nothing that was already there')
  assert.equal(diff.added, 4)
  assert.deepEqual(textsOf(diff.lines, 'add'), ['', 'function two() {', '  return 2', '}'])
})

test('changing one line inside the second of three near-identical blocks touches only that line', () => {
  // Nine lines, three of them `}` and three of them `  return N`. If alignment latched onto
  // the wrong repeated line the counts would come out larger than one and one, and the diff
  // would blame the wrong function.
  const before = [
    'function one() {',
    '  return 1',
    '}',
    'function two() {',
    '  return 2',
    '}',
    'function three() {',
    '  return 3',
    '}',
  ].join('\n')
  const after = before.replace('  return 2', '  return 22')
  const diff = editDiff(before, after)

  assert.equal(diff.added, 1)
  assert.equal(diff.removed, 1)
  assert.deepEqual(textsOf(diff.lines, 'del'), ['  return 2'])
  assert.deepEqual(textsOf(diff.lines, 'add'), ['  return 22'])
})

test('a block moved past another block is reported as removing and re-adding that block, not as rewriting both', () => {
  // Swapping two four-line blocks: the smallest honest answer moves one block, so four lines
  // go and four lines come back. Anything larger means the shared `}` and blank lines pulled
  // the alignment apart; anything smaller is not a valid diff at all.
  const before = [
    "import fs from 'fs'",
    '',
    'export function one() {',
    '  return 1',
    '}',
    '',
    'export function two() {',
    '  return 2',
    '}',
  ].join('\n')
  const after = [
    "import fs from 'fs'",
    '',
    'export function two() {',
    '  return 2',
    '}',
    '',
    'export function one() {',
    '  return 1',
    '}',
  ].join('\n')
  const diff = editDiff(before, after)

  assert.equal(diff.added, 4)
  assert.equal(diff.removed, 4)

  const lines = flatten(diff.lines)
  assert.equal(lines[0]?.kind, 'ctx', 'the untouched import stays context')
  assert.equal(lines[0]?.text, "import fs from 'fs'")
  assert.deepEqual(
    lines.filter((line) => line.kind !== 'add').map((line) => line.text),
    before.split('\n'),
    'reading past the additions gives back the old text',
  )
  assert.deepEqual(
    lines.filter((line) => line.kind !== 'del').map((line) => line.text),
    after.split('\n'),
    'reading past the deletions gives back the new text',
  )
})

test('every diff over a two-symbol alphabet reconstructs both sides and costs no more than the optimum', () => {
  // The two properties that make a diff true rather than merely plausible:
  //
  //   1. context + deletions, read in order, is exactly the old text; context + additions is
  //      exactly the new text. This fails the moment alignment invents or drops a line.
  //   2. added + removed equals |a| + |b| - 2 * LCS(a, b), computed here by an independent
  //      dynamic program. This fails the moment alignment pairs the wrong equal lines and
  //      has to pay for it somewhere else.
  //
  // Two symbols is the worst case on purpose: every line is a repeated line.
  const lcsLength = (a: string[], b: string[]): number => {
    const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        const row = dp[i] as number[]
        const next = dp[i + 1] as number[]
        row[j] = a[i] === b[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number)
      }
    }
    return (dp[0] as number[])[0] as number
  }

  const sequences: string[][] = []
  for (let length = 0; length <= 5; length += 1) {
    for (let mask = 0; mask < 1 << length; mask += 1) {
      const seq: string[] = []
      for (let bit = 0; bit < length; bit += 1) seq.push((mask >> bit) & 1 ? 'y' : 'x')
      sequences.push(seq)
    }
  }

  let checked = 0
  for (const a of sequences) {
    for (const b of sequences) {
      const diff = editDiff(a.join('\n'), b.join('\n'))
      const lines = flatten(diff.lines)
      const label = `${a.join('')} -> ${b.join('')}`

      assert.deepEqual(
        lines.filter((line) => line.kind !== 'add').map((line) => line.text),
        a,
        `old side reconstructs for ${label}`,
      )
      assert.deepEqual(
        lines.filter((line) => line.kind !== 'del').map((line) => line.text),
        b,
        `new side reconstructs for ${label}`,
      )
      assert.equal(
        diff.added + diff.removed,
        a.length + b.length - 2 * lcsLength(a, b),
        `diff is minimal for ${label}`,
      )
      checked += 1
    }
  }
  assert.equal(checked, sequences.length ** 2)
})

// ---------------------------------------------------------------------------
// Word-level marks inside a changed line.
// ---------------------------------------------------------------------------

test('only the word that changed is marked, and neighbouring tokens of one kind become a single run', () => {
  const mark = pairParts('const a = 1', 'const b = 1')
  assert.ok(mark !== null, 'two lines this close are worth pairing')

  // `tokenize` produces seven tokens per side here (`const`, ` `, `a`, ` `, `=`, ` `, `1`).
  // The comment in `wordParts` promises the DOM gets runs rather than one span per token, so
  // the unchanged tokens either side must arrive merged: three parts, not seven.
  assert.deepEqual(mark.del, [
    { text: 'const ', changed: false },
    { text: 'a', changed: true },
    { text: ' = 1', changed: false },
  ])
  assert.deepEqual(mark.add, [
    { text: 'const ', changed: false },
    { text: 'b', changed: true },
    { text: ' = 1', changed: false },
  ])
})

test('the marked parts of a line always join back to the line itself, so nothing is lost or duplicated', () => {
  const cases: [string, string][] = [
    ['const a = 1', 'const b = 1'],
    ['  return items.length', '  return items.size'],
    ['if (a && b) {', 'if (a || b) {'],
    ['const x = "héllo"', 'const x = "héllo!"'],
  ]
  for (const [before, after] of cases) {
    const mark = pairParts(before, after)
    assert.ok(mark !== null, `${before} and ${after} are close enough to pair`)
    assert.equal(mark.del.map((part) => part.text).join(''), before)
    assert.equal(mark.add.map((part) => part.text).join(''), after)
  }
})

test('a dot ends a token but an underscore does not, so a renamed snake_case word is marked whole', () => {
  // `tokenize` is `/[A-Za-z0-9_$]+|\s+|./g`: letters, digits, `_` and `$` glue into one word,
  // and anything else is a token of its own. So the two lines below differ in the same way to
  // a reader but not to the tokenizer.
  const dotted = pairParts('const x = metrics.total.count + 1', 'const x = metrics.total.amount + 1')
  assert.ok(dotted !== null)
  assert.deepEqual(dotted.del, [
    { text: 'const x = metrics.total.', changed: false },
    { text: 'count', changed: true },
    { text: ' + 1', changed: false },
  ])

  const snake = pairParts('const x = metrics.total_count + 1', 'const x = metrics.total_amount + 1')
  assert.ok(snake !== null)
  assert.deepEqual(snake.del, [
    { text: 'const x = metrics.', changed: false },
    { text: 'total_count', changed: true },
    { text: ' + 1', changed: false },
  ])
})

test('two lines with nothing in common are not paired, so neither carries word marks', () => {
  // Below PAIR_THRESHOLD (0.3): these two share no token at all, so a mark would be inventing
  // a relationship between unrelated lines.
  assert.equal(pairParts('alpha', 'omega'), null)

  const diff = editDiff('keep\nalpha\ntail', 'keep\nomega\ntail')
  const lines = flatten(diff.lines)
  assert.equal(lines[1]?.parts, undefined, 'the deletion renders as plain text')
  assert.equal(lines[2]?.parts, undefined, 'the addition renders as plain text')
})

test('a line that was rewritten almost entirely gets no marks, because a mostly-highlighted line is noise', () => {
  // similarity here is 0.4 (`hello` and one space are shared out of ten tokens), which clears
  // PAIR_THRESHOLD, so it is MARK_CEILING that rejects this: the addition would come back
  // with 27 of its 33 characters highlighted, and the `+` already said the line changed.
  assert.equal(pairParts('hello world', 'hello everyone entirely different'), null)
})

test('word marks survive into the rendered lines of a real diff, on both the deletion and the addition', () => {
  const before = ['function one() {', '  return 1', '}'].join('\n')
  const after = ['function one() {', '  return 2', '}'].join('\n')
  const lines = flatten(editDiff(before, after).lines)

  assert.deepEqual(lines[1]?.parts, [
    { text: '  return ', changed: false },
    { text: '1', changed: true },
  ])
  assert.deepEqual(lines[2]?.parts, [
    { text: '  return ', changed: false },
    { text: '2', changed: true },
  ])
})

// ---------------------------------------------------------------------------
// Folding long unchanged stretches.
// ---------------------------------------------------------------------------

test('a long unchanged stretch between two changes folds to one marker with three lines of context either side', () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${String(i).padStart(2, '0')}`)
  const after = [...before]
  after[0] = 'line 00 changed'
  after[19] = 'line 19 changed'
  const diff = editDiff(before.join('\n'), after.join('\n'))

  assert.deepEqual(kindsOf(diff.lines), [
    'del',
    'add',
    'ctx',
    'ctx',
    'ctx',
    'fold',
    'ctx',
    'ctx',
    'ctx',
    'del',
    'add',
  ])

  const fold = diff.lines[5] as DiffLine
  // CONTEXT is 3, so lines 01..03 and 16..18 stay in view and the twelve lines between them
  // are the ones worth folding away.
  assert.equal(fold.hidden?.length, 12)
  assert.deepEqual(fold.hidden?.map((line) => line.text), before.slice(4, 16))
  assert.ok(
    fold.hidden?.every((line) => line.kind === 'ctx'),
    'only unchanged lines are ever folded',
  )
})

test('opening every fold gives back the diff in full, so folding hides lines without dropping them', () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i}`)
  const after = [...before]
  after[2] = 'line 2 changed'
  after[27] = 'line 27 changed'
  const diff = editDiff(before.join('\n'), after.join('\n'))
  const lines = flatten(diff.lines)

  assert.deepEqual(
    lines.filter((line) => line.kind !== 'add').map((line) => line.text),
    before,
  )
  assert.deepEqual(
    lines.filter((line) => line.kind !== 'del').map((line) => line.text),
    after,
  )
})

// ---------------------------------------------------------------------------
// Line numbers: the comment says a write is numbered and an edit is not.
// ---------------------------------------------------------------------------

test('a whole-file write numbers its lines from one, because for a write the position is known', () => {
  const diff = writeDiff('alpha\nbeta\ngamma')

  assert.equal(diff.whole, true)
  assert.deepEqual(diff.lines.map((line) => line.n), [1, 2, 3])
})

test('an edit leaves every line unnumbered rather than guessing a position the transcript never recorded', () => {
  const diff = editDiff('alpha\nbeta\ngamma', 'alpha\nBETA\ngamma')

  assert.equal(diff.whole, false)
  assert.ok(
    flatten(diff.lines).every((line) => line.n === undefined),
    'no line carries a number, not even the unchanged ones',
  )
})

// ---------------------------------------------------------------------------
// The size guard on the quadratic table.
// ---------------------------------------------------------------------------

test('a change small enough for the table is aligned properly, and one too big degrades to a wholesale replace', () => {
  // Both cases have the same shape: the first and last lines differ, so nothing can be trimmed
  // from the head or the tail, and one middle line is dropped. The honest answer is two
  // deletions plus one addition for the endpoints, plus the one dropped line.
  const shaped = (size: number): FileDiff => {
    const before = Array.from({ length: size }, (_, i) => `const v${i} = ${i}`)
    const after = [...before]
    after[0] = 'const first = 0'
    after[size - 1] = `const last = ${size - 1}`
    after.splice(size >> 1, 1)
    return editDiff(before.join('\n'), after.join('\n'))
  }

  const small = shaped(1000)
  assert.equal(small.removed, 3, 'two endpoints and the dropped line')
  assert.equal(small.added, 2, 'two endpoints')

  // 2001 x 2000 is 4,002,000 cells, over LCS_CELL_LIMIT, so the middle is replaced wholesale
  // instead of searched. That is a deliberate trade: a worse diff, but it returns.
  const big = shaped(2001)
  assert.equal(big.removed, 2001)
  assert.equal(big.added, 2000)
})

// ---------------------------------------------------------------------------
// Which tool calls turn into diffs at all.
// ---------------------------------------------------------------------------

test('a tool that does not edit a file, or one missing a side of the edit, produces no diff at all', () => {
  assert.equal(toolDiffs('Bash', { command: 'ls' }), null)
  assert.equal(toolDiffs('Edit', { file_path: '/tmp/f.ts', old_string: 'a' }), null, 'no new_string')
  assert.equal(toolDiffs('Write', { file_path: '/tmp/f.ts' }), null, 'no content')
  assert.equal(toolDiffs('MultiEdit', { file_path: '/tmp/f.ts', edits: [] }), null, 'no usable edits')
  assert.equal(
    toolDiffs('MultiEdit', { file_path: '/tmp/f.ts', edits: [{ old_string: 'a' }] }),
    null,
    'an edit missing a side is not a diff',
  )
})

test('a MultiEdit becomes one diff per edit, each carrying its own before and after', () => {
  const diffs = toolDiffs('MultiEdit', {
    file_path: '/tmp/f.ts',
    edits: [
      { old_string: 'alpha', new_string: 'ALPHA' },
      { old_string: 'beta', new_string: 'BETA' },
    ],
  })

  assert.equal(diffs?.length, 2)
  assert.deepEqual(textsOf(flatten(diffs?.[0]?.lines ?? []), 'del'), ['alpha'])
  assert.deepEqual(textsOf(flatten(diffs?.[1]?.lines ?? []), 'add'), ['BETA'])
  assert.notEqual(diffs?.[0]?.label, diffs?.[1]?.label, 'the label says which edit this is')
})

test('a notebook edit is a whole-file write only when there was no previous source to compare against', () => {
  const fresh = toolDiffs('NotebookEdit', { notebook_path: '/tmp/n.ipynb', new_source: 'x = 1' })
  assert.equal(fresh?.[0]?.whole, true)
  assert.equal(fresh?.[0]?.path, '/tmp/n.ipynb', 'the notebook path is where the path comes from')
  assert.deepEqual(fresh?.[0]?.lines.map((line) => line.n), [1])

  const revised = toolDiffs('NotebookEdit', {
    notebook_path: '/tmp/n.ipynb',
    old_source: 'x = 1',
    new_source: 'x = 2',
  })
  assert.equal(revised?.[0]?.whole, false)
  assert.equal(revised?.[0]?.added, 1)
  assert.equal(revised?.[0]?.removed, 1)
})

test('a trailing newline is not a line of its own, so writing one line reports one line added', () => {
  // A plain split leaves a phantom empty element on text ending in a newline, and counting
  // it made this write report `added: 2` and draw a blank green line under the last real
  // one. `toLines` drops a single trailing empty element, the way conventional diff tools
  // treat a trailing newline as terminating the last line rather than starting a new one.
  const diff = writeDiff('const x = 1\n')

  assert.equal(diff.added, 1)
  assert.deepEqual(diff.lines.map((line) => line.text), ['const x = 1'])

  // Exactly one element, though: a file whose last line is blank still has that line, and
  // trimming every trailing empty would lose it and miscount the other way.
  const blankLast = writeDiff('const x = 1\n\n')
  assert.equal(blankLast.added, 2)
  assert.deepEqual(blankLast.lines.map((line) => line.text), ['const x = 1', ''])

  // The same rule on both sides of an edit, so a hunk that ends in a newline does not
  // report an unchanged phantom line as context either.
  const edit = editDiff('a\nb\n', 'a\nB\n')
  assert.deepEqual(kindsOf(flatten(edit.lines)), ['ctx', 'del', 'add'])
})
