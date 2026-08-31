import { useCallback, useEffect, useRef, useState } from 'react'
import type { AttentionItem } from '../shared/types.ts'

/**
 * Poll the attention queue.
 *
 * The fleet itself arrives over a WebSocket, but the queue is derived rather than pushed:
 * a session crosses into `waiting` or out of it by the clock alone, with nothing written
 * to notice, so it is fetched on a timer. `reload` exists because acting on an item —
 * nudging a session, say — changes the answer immediately and waiting out the interval
 * would look broken.
 */
export function useAttention(intervalMs = 5000): { items: AttentionItem[]; reload: () => void } {
  const [items, setItems] = useState<AttentionItem[]>([])
  const stopped = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch('/api/attention')
      if (!response.ok) return
      const body = (await response.json()) as { items: AttentionItem[] }
      if (!stopped.current) setItems(body.items)
    } catch {
      // A queue that cannot load stays as it was rather than emptying itself.
    }
  }, [])

  useEffect(() => {
    stopped.current = false
    void load()
    const timer = setInterval(() => void load(), intervalMs)
    return () => {
      stopped.current = true
      clearInterval(timer)
    }
  }, [load, intervalMs])

  return { items, reload: () => void load() }
}

const DISMISSED_KEY = 'aivis.dismissed'
const DISMISSED_MAX = 200

/**
 * Remember which queue items you have waved away.
 *
 * An item's id carries the state it describes, so dismissing one hides that particular
 * wait and not the session: the same session stopping again produces a new id and comes
 * back. The list is capped and kept oldest-first, so it never grows without bound.
 */
export function useDismissed(): {
  dismissed: Set<string>
  dismiss: (id: string) => void
  restore: () => void
} {
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(DISMISSED_KEY)
      return new Set(raw ? (JSON.parse(raw) as string[]) : [])
    } catch {
      return new Set()
    }
  })

  const write = (next: Set<string>): void => {
    setDismissed(next)
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify([...next].slice(-DISMISSED_MAX)))
    } catch {
      // Storage that refuses to write just means dismissals last this session only.
    }
  }

  return {
    dismissed,
    dismiss: (id) => write(new Set(dismissed).add(id)),
    restore: () => write(new Set()),
  }
}
