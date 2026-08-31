import { useEffect, useState } from 'react'
import type { Defaults } from '../shared/types.ts'

/**
 * What a new session inherits, and the thresholds the index quotes when it explains
 * itself.
 *
 * Read once and never refreshed: these come from settings files and environment
 * variables, which change when you restart the server rather than while you watch.
 */
export function useDefaults(): Defaults | null {
  const [defaults, setDefaults] = useState<Defaults | null>(null)
  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const response = await fetch('/api/defaults')
        if (!response.ok) return
        const body = (await response.json()) as Defaults
        if (live) setDefaults(body)
      } catch {
        // The index falls back to naming no numbers, which is better than wrong ones.
      }
    })()
    return () => {
      live = false
    }
  }, [])
  return defaults
}
