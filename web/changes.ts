/**
 * What the session itself edited, read out of the transcript.
 *
 * This is the base that needs no repository: every `Write`, `Edit`, `MultiEdit`, and
 * `NotebookEdit` in the loaded conversation, grouped by the file it touched. It answers a
 * question git cannot — which tool call wrote this line — and it is the only base that
 * works in a directory that is not a repository at all.
 *
 * What it cannot see is anything that left no tool call behind: a file removed with `rm`,
 * or one edited in a terminal beside the agent. The git bases cover those.
 */

import type { TranscriptEntry } from '../shared/types.ts'
import { toolDiffs, type FileDiff } from './diff.ts'

/** One tool call that wrote to a file. */
export interface FileEdit {
  /** Tool-call id, which is what the conversation anchors on. */
  callId: string
  tool: string
  at: string
  added: number
  removed: number
  diffs: FileDiff[]
  /** What the call did, taken from the diff labels: `Write`, `Edit 2 of 3`, and so on. */
  label: string
}

/** Every edit the session made to one file. */
export interface TouchedFile {
  /** Path as the tool call gave it, usually absolute. */
  path: string
  /** The same path relative to the session's working directory. */
  rel: string
  added: number
  removed: number
  edits: FileEdit[]
  lastAt: string
  /**
   * True when the first `Write` to this file reported creating it. Claude Code answers a
   * `Write` with either "File created successfully at…" or a note that the file was
   * updated, so the transcript does say which happened — for files it wrote itself.
   */
  created: boolean
}

/** Strip the working directory from a path, so a row reads as `app/pricing/matching.py`. */
export function relativeTo(cwd: string, file: string): string {
  if (cwd && file.startsWith(cwd + '/')) return file.slice(cwd.length + 1)
  return file
}

/**
 * Group the loaded conversation's file edits by file, biggest change first.
 *
 * Subagent turns are included: an edit an agent made is still an edit this session made,
 * and the conversation shows those tool calls too.
 */
export function sessionChanges(entries: TranscriptEntry[], cwd: string): TouchedFile[] {
  const byPath = new Map<string, TouchedFile>()

  for (const entry of entries) {
    if (entry.kind !== 'tool') continue
    const { call } = entry
    const diffs = toolDiffs(call.name, call.input)
    if (!diffs || diffs.length === 0) continue

    const file = diffs[0]?.path ?? ''
    if (!file) continue

    const edit: FileEdit = {
      callId: call.id,
      tool: call.name,
      at: entry.at,
      added: diffs.reduce((sum, diff) => sum + diff.added, 0),
      removed: diffs.reduce((sum, diff) => sum + diff.removed, 0),
      diffs,
      label: diffs.length === 1 ? (diffs[0]?.label ?? call.name) : `${diffs.length} hunks`,
    }

    const existing = byPath.get(file)
    if (existing) {
      existing.edits.push(edit)
      existing.added += edit.added
      existing.removed += edit.removed
      existing.lastAt = entry.at
      continue
    }

    byPath.set(file, {
      path: file,
      rel: relativeTo(cwd, file),
      added: edit.added,
      removed: edit.removed,
      edits: [edit],
      lastAt: entry.at,
      created: call.name === 'Write' && (call.result ?? '').startsWith('File created'),
    })
  }

  return [...byPath.values()].sort(
    (a, b) => b.added + b.removed - (a.added + a.removed) || a.rel.localeCompare(b.rel),
  )
}
