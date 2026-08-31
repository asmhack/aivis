import { useEffect, useState } from 'react'
import type { BlockUsage } from '../shared/types.ts'

/**
 * Poll the account's rate-limit and throughput figures.
 *
 * These move on the scale of minutes, so a slow timer is enough; both the meter in the
 * header and the fleet's throughput readouts read the same endpoint through this hook.
 */
export function useBlockUsage(intervalMs = 30000): BlockUsage | null {
  const [usage, setUsage] = useState<BlockUsage | null>(null)

  useEffect(() => {
    let stopped = false
    const load = async (): Promise<void> => {
      try {
        const response = await fetch('/api/usage/blocks')
        if (!response.ok) return
        const body = (await response.json()) as BlockUsage
        if (!stopped) setUsage(body)
      } catch {
        // Figures that cannot load simply do not render.
      }
    }
    void load()
    const timer = setInterval(() => void load(), intervalMs)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [intervalMs])

  return usage
}
