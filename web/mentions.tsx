import { useEffect, useState, type KeyboardEvent, type RefObject } from 'react'

import type { CommandHit, FileHit } from '../shared/types.ts'

/**
 * The `@` file picker and the `/` command picker, shared by everywhere you type a prompt.
 *
 * Both menus are the same idea twice: find the token under the caret, ask the server what
 * matches it in one directory, and replace the token with what you chose. What differs
 * between the places they appear is only which directory is being asked about — a live
 * session already knows its own, while the new-session sheet has a folder it is about to
 * start in and no session yet. That difference is the `MentionTarget` below; everything
 * after it is identical, which is why it lives here rather than twice in two components.
 */

/**
 * Which directory the menus search.
 *
 * A running session answers for itself: the server holds its working directory, so the id
 * is enough. A session that does not exist yet has only the folder it was pointed at, so
 * the path goes on the wire instead. Both end in the same two searches over the same
 * directory — only the address differs.
 */
export type MentionTarget = { session: string } | { cwd: string }

/** A token being typed: the text after the sigil, and the offset the sigil sits at. */
interface Token {
  query: string
  start: number
}

export interface Mentions {
  files: FileHit[]
  commands: CommandHit[]
  /** True when the file menu is on screen, and so owns the arrow keys and Enter. */
  filesOpen: boolean
  slashOpen: boolean
  /** True when either menu is open, which is what a surrounding Escape handler must check. */
  open: boolean
  picked: number
  /** True when text precedes the `/`, so the token names a command rather than running one. */
  midSentence: boolean
  setPicked: (index: number) => void
  /** Re-read the token under the caret, after a keystroke, a click, or a paste. */
  detect: (value: string, caret: number) => void
  close: () => void
  chooseFile: (hit: FileHit) => void
  chooseCommand: (hit: CommandHit) => void
  /**
   * Take the keys the open menu owns. Returns true when one was consumed, so the caller
   * knows not to also send the message or close the dialog it was typed in.
   */
  keyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
}

/** Where a search goes for the target it is searching. */
function endpoint(target: MentionTarget, kind: 'files' | 'commands', query: string): string {
  const q = `q=${encodeURIComponent(query)}`
  return 'session' in target
    ? `/api/sessions/${encodeURIComponent(target.session)}/${kind}?${q}`
    : `/api/${kind}?cwd=${encodeURIComponent(target.cwd)}&${q}`
}

/**
 * What one address answers, refetched whenever the address changes.
 *
 * Debounced, because every keystroke inside a token would otherwise re-query. A reply that
 * arrives after the token has moved on is dropped rather than shown, so a slow answer can
 * never overwrite a newer one. The address is a plain string on purpose: it is the whole
 * of what the query depends on, so it can be compared as a dependency without the target
 * object's identity changing on every render.
 */
function useHits<T>(url: string | null): T[] {
  const [hits, setHits] = useState<T[]>([])
  useEffect(() => {
    if (url === null) {
      setHits([])
      return
    }
    let stopped = false
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(url)
        if (!response.ok) return
        const body = (await response.json()) as { hits: T[] }
        if (!stopped) setHits(body.hits)
      } catch {
        if (!stopped) setHits([])
      }
    }, 90)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [url])
  return hits
}

/**
 * Drive both menus for one text field.
 *
 * The field owns its own text — this only reads it and hands back the replacement — so a
 * composer that also sends messages and a sheet that also starts sessions can each keep
 * their own state and still get the same picker.
 */
export function useMentions({
  target,
  text,
  setText,
  inputRef,
}: {
  /** Null while nothing has been chosen to search, which keeps both menus closed. */
  target: MentionTarget | null
  text: string
  setText: (next: string) => void
  inputRef: RefObject<HTMLTextAreaElement | null>
}): Mentions {
  const [mention, setMention] = useState<Token | null>(null)
  const [slash, setSlash] = useState<Token | null>(null)
  const [picked, setPicked] = useState(0)

  const files = useHits<FileHit>(target && mention ? endpoint(target, 'files', mention.query) : null)
  const commands = useHits<CommandHit>(
    target && slash ? endpoint(target, 'commands', slash.query) : null,
  )

  const filesOpen = mention !== null && files.length > 0
  const slashOpen = slash !== null && commands.length > 0

  /**
   * Find an `@file` token ending at the caret.
   *
   * The token has to start at a word boundary, so an email address or a decorator does
   * not open the picker, and it ends at the caret so typing past a chosen path closes it.
   */
  const detectMention = (value: string, caret: number): void => {
    const match = value.slice(0, caret).match(/(?:^|\s)@([^\s]*)$/)
    if (!match) {
      setMention(null)
      return
    }
    const query = match[1] ?? ''
    setMention({ query, start: caret - query.length - 1 })
    setPicked(0)
  }

  /**
   * Find a `/command` token ending at the caret.
   *
   * The token has to start at a word boundary, the same rule the `@` picker follows, so a
   * path or a date does not open the menu. It is deliberately not anchored to the start of
   * the message: naming a skill inside a sentence — "use /graphify on this" — is a normal
   * thing to want, and the picker is how you find the exact name.
   *
   * Only a message that *begins* with a command is expanded into what it stands for, which
   * is the CLI's rule and stays untouched. A name mentioned mid-sentence is delivered as the
   * text you typed, which is what makes it a reference rather than an invocation.
   */
  const detectSlash = (value: string, caret: number): void => {
    const match = value.slice(0, caret).match(/(?:^|\s)\/(\S*)$/)
    if (!match) {
      setSlash(null)
      return
    }
    const query = match[1] ?? ''
    setSlash({ query, start: caret - query.length - 1 })
    setPicked(0)
  }

  const detect = (value: string, caret: number): void => {
    detectMention(value, caret)
    detectSlash(value, caret)
  }

  const close = (): void => {
    setMention(null)
    setSlash(null)
  }

  /**
   * Put the chosen text in place of the token being typed.
   *
   * Only the token is replaced. Rebuilding the message from its start, which is what this
   * did while commands could only be message-initial, threw away everything written before
   * a name mentioned mid-sentence.
   */
  const replace = (token: Token, inserted: string): void => {
    const input = inputRef.current
    const caret = input?.selectionStart ?? text.length
    setText(`${text.slice(0, token.start)}${inserted} ${text.slice(caret)}`)
    close()
    requestAnimationFrame(() => {
      const at = token.start + inserted.length + 1
      input?.focus()
      input?.setSelectionRange(at, at)
    })
  }

  const chooseFile = (hit: FileHit): void => {
    if (mention) replace(mention, `@${hit.path}`)
  }

  /**
   * Insert the chosen command, ready for arguments.
   *
   * A built-in is inserted too, so it can be seen and copied, even where sending it is
   * refused with a note — in a session aivis does not drive it runs in the terminal.
   */
  const chooseCommand = (hit: CommandHit): void => {
    if (slash) replace(slash, `/${hit.name}`)
  }

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    // The file menu owns these keys while it is open, so Enter picks a file rather than
    // sending a half-typed message.
    if (filesOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setPicked((current) => (current + 1) % files.length)
        return true
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setPicked((current) => (current - 1 + files.length) % files.length)
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const hit = files[picked]
        if (hit) {
          event.preventDefault()
          chooseFile(hit)
          return true
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMention(null)
        return true
      }
      return false
    }

    if (slashOpen) {
      // Only the runnable hits take keyboard focus; built-ins are greyed where they cannot
      // run. With no hit at all (a fully typed `/compact`) Enter falls through to the
      // field's own handler, and the server answers with the terminal-only note.
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setPicked((current) => (current + 1) % commands.length)
        return true
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setPicked((current) => (current - 1 + commands.length) % commands.length)
        return true
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setSlash(null)
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const hit = commands[picked]
        if (hit) {
          event.preventDefault()
          chooseCommand(hit)
          return true
        }
      }
    }
    return false
  }

  return {
    files,
    commands,
    filesOpen,
    slashOpen,
    open: filesOpen || slashOpen,
    picked,
    midSentence: slash !== null && slash.start > 0,
    setPicked,
    detect,
    close,
    chooseFile,
    chooseCommand,
    keyDown,
  }
}

/**
 * The two menus themselves, drawn above the field they belong to.
 *
 * They are absolutely positioned, so whatever wraps them has to be the positioned box —
 * the composer, or the sheet's prompt field — and must not clip what overflows it.
 */
export function MentionMenus({
  mentions,
  nativeSlash = true,
  flush = false,
}: {
  mentions: Mentions
  /**
   * Whether a slash command typed here will actually be parsed as one. False only for a
   * session running in someone else's terminal, which aivis reaches over a socket that
   * does not run commands; those rows are shown for discoverability but dimmed.
   */
  nativeSlash?: boolean
  /** True when the anchor has no padding of its own, so the menu spans it edge to edge. */
  flush?: boolean
}): React.JSX.Element | null {
  const box = `mentions ${flush ? 'mentions--flush' : ''}`
  return (
    <>
      {mentions.filesOpen ? (
        <div className={box}>
          <p className="mentions__head">files in this project · ↑↓ to move, ⏎ to insert</p>
          {mentions.files.map((hit, index) => (
            <button
              key={hit.path}
              className={`mention ${index === mentions.picked ? 'mention--on' : ''}`}
              onMouseEnter={() => mentions.setPicked(index)}
              onClick={() => mentions.chooseFile(hit)}
            >
              <span className="mention__name">{hit.name}</span>
              <span className="mention__dir">{hit.dir}</span>
            </button>
          ))}
        </div>
      ) : null}

      {mentions.slashOpen ? (
        <div className={box}>
          <p className="mentions__head">
            commands &amp; skills · {mentions.midSentence ? 'named, not run · ' : ''}↑↓ to move, ⏎
            to insert
          </p>
          {mentions.commands.map((hit, index) => (
            <button
              key={`${hit.kind}:${hit.name}`}
              className={`mention mention--cmd ${hit.runnable || nativeSlash ? '' : 'mention--term'} ${index === mentions.picked ? 'mention--on' : ''}`}
              onMouseEnter={() => mentions.setPicked(index)}
              onClick={() => mentions.chooseCommand(hit)}
              title={
                hit.runnable || nativeSlash
                  ? undefined
                  : 'This session runs in a terminal, which aivis reaches over a socket that does not run slash commands. It works in sessions aivis drives.'
              }
            >
              <span className="mention__name">/{hit.name}</span>
              <span className="mention__dir">{hit.description}</span>
              <span className="cmd__tag">{hit.kind === 'skill' ? 'skill' : hit.source}</span>
            </button>
          ))}
        </div>
      ) : null}
    </>
  )
}
