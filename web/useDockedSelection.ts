import { useEffect, useRef } from 'react'

/**
 * Keep the docked list's selected row in view.
 *
 * The list beside a docked detail can be sixty agents or two hundred files long, so a
 * selection arrived at from the level above — or stepped through with the sibling arrows —
 * usually starts somewhere the reader cannot see. Scrolling to it is what makes the list
 * answer "which one of these am I looking at?" rather than just offering the others.
 *
 * `nearest` scrolls only as far as it must, so a selection already on screen stays exactly
 * where the reader last saw it instead of jumping to the middle.
 *
 * Attach the returned ref to the selected row and pass whatever identifies it as `key`.
 */
export function useDockedSelection(key: string | number): React.RefObject<HTMLButtonElement | null> {
  const selected = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    selected.current?.scrollIntoView({ block: 'nearest' })
  }, [key])

  return selected
}
