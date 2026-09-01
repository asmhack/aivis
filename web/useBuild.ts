import { useEffect, useState } from 'react'
import type { BuildStatus } from '../shared/types.ts'

/**
 * Whether the server answering this page was started from the same build the page came
 * from. `unknown` is the answer while the question is still out, and after a request that
 * never arrived at all.
 */
export type BuildAgreement = 'ok' | 'stale' | 'unknown'

/**
 * Read the server's answer, or the absence of one.
 *
 * Kept apart from the request so the rule can be read on its own, because the interesting
 * case is not the JSON. A server started before `/api/build` existed does not answer 404:
 * an unknown `/api` path falls through to the static handler, which serves `index.html`
 * with a 200. So a reply that is not the JSON this asked for is itself the finding — a
 * server that cannot answer the question is, with certainty, older than the page that
 * knows to ask it, and those are the servers this exists for.
 *
 * `null` is a request that failed outright, which says the server is unreachable rather
 * than old. The socket already reports that, and a second notice would only compete.
 */
export async function agreementFrom(response: Response | null): Promise<BuildAgreement> {
  if (response === null) return 'unknown'
  if (!response.ok) return 'stale'
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) return 'stale'
  try {
    const status = (await response.json()) as BuildStatus
    return status.stale ? 'stale' : 'ok'
  } catch {
    return 'stale'
  }
}

/**
 * Asked once per page and shared by everything that wants the answer.
 *
 * Two places do: the notice that floats over the app, and the crash panel, which the error
 * boundary renders precisely when the disagreement has already thrown. Neither can wait on
 * the other and one fetch answers both, so the promise belongs to the module rather than to
 * either component.
 */
let asked: Promise<BuildAgreement> | null = null

async function askOnce(): Promise<BuildAgreement> {
  try {
    return await agreementFrom(await fetch('/api/build'))
  } catch {
    return agreementFrom(null)
  }
}

/**
 * Ask whether this page and the server behind it come from the same build.
 *
 * The two are one program in two processes with separate lifetimes: `npm run build`
 * replaces the front end on disk, and a server left running goes on serving it while
 * answering from the code it started with. What the reader sees when they disagree is a
 * render crash naming a field nobody has heard of, so the page asks outright instead.
 */
export function useBuild(): BuildAgreement {
  const [agreement, setAgreement] = useState<BuildAgreement>('unknown')
  useEffect(() => {
    let live = true
    asked ??= askOnce()
    void asked.then((answer) => {
      if (live) setAgreement(answer)
    })
    return () => {
      live = false
    }
  }, [])
  return agreement
}
