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
 *
 * `loaded` is false until a fetch has actually come back. An empty queue and a queue not
 * yet read are the same value here, and notifications have to tell them apart: taking the
 * second for the first would make the first real answer look like a fleet that just now
 * started needing you, and announce all of it.
 */
export function useAttention(
  /**
   * True while the server is pushing the queue over the fleet socket, which makes this poll
   * redundant. It is a parameter rather than a decision made here because only the caller
   * can see the socket, and only the socket knows whether it is still open.
   */
  paused = false,
  intervalMs = 5000,
): {
  items: AttentionItem[]
  loaded: boolean
  reload: () => void
} {
  const [items, setItems] = useState<AttentionItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const stopped = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch('/api/attention')
      if (!response.ok) return
      const body = (await response.json()) as { items: AttentionItem[] }
      if (stopped.current) return
      setItems(body.items)
      // Only ever set from a reply that arrived. A failed fetch leaves the queue as it was,
      // and calling that loaded would put a baseline under a queue nobody has read.
      setLoaded(true)
    } catch {
      // A queue that cannot load stays as it was rather than emptying itself.
    }
  }, [])

  useEffect(() => {
    if (paused) return
    stopped.current = false
    void load()
    const timer = setInterval(() => void load(), intervalMs)
    return () => {
      stopped.current = true
      clearInterval(timer)
    }
  }, [load, intervalMs, paused])

  return { items, loaded, reload: () => void load() }
}

/**
 * Which of the two queues to believe.
 *
 * There are two because the socket is the better source and cannot be the only one: a server
 * older than the build that added the pushed message never sends it, and a socket that has
 * dropped stops sending it without saying so. Neither case may be allowed to look like a
 * fleet that has gone quiet, which is what an empty queue would claim.
 *
 * So the socket wins while it is open and has spoken, the poll wins once it has answered, and
 * what the socket last said stands in for the moment in between — stale by a few seconds,
 * which is the mildest of the three ways this can be wrong.
 */
export function preferredQueue(
  pushed: AttentionItem[] | null,
  socketOpen: boolean,
  polled: AttentionItem[],
  polledLoaded: boolean,
): { items: AttentionItem[]; loaded: boolean } {
  if (socketOpen && pushed) return { items: pushed, loaded: true }
  if (polledLoaded) return { items: polled, loaded: true }
  return pushed ? { items: pushed, loaded: true } : { items: [], loaded: false }
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
