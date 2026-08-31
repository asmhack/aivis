import { useEffect, useRef, useState } from 'react'
import type { DriverStatus, ServerMessage, Session } from '../shared/types.ts'

export type ConnectionState = 'connecting' | 'open' | 'closed'

/**
 * How long after a snapshot the drivers it was not followed by are kept.
 *
 * The server writes a status for every driver it still holds into the socket immediately
 * after the snapshot, so anything it does not mention is a driver it no longer has — a
 * restarted daemon drives none of the sessions the one before it did, and says so only by
 * going quiet about them. But each frame arrives as its own event and so as its own render,
 * so emptying the map on the snapshot itself would leave a render in between with no drivers
 * at all, and that render is not free: the answer card is keyed by its request, so it would
 * unmount and take the options already ticked and the words already typed with it, and the
 * composer would flash 'running in a terminal' at a session aivis is driving. Sweeping on a
 * delay instead means no render ever sees the gap. The delay only has to outlast the trip
 * from a server on this machine writing frames it has already queued, so a fraction of a
 * second is generous; what it costs is that a driver the new daemon does not have stays on
 * screen that much longer after a reconnect.
 */
const SNAPSHOT_SWEEP_MS = 500

/**
 * Drop the driver statuses that did not arrive again after the last snapshot.
 *
 * Kept apart from the socket so the rule can be read on its own: what a snapshot means is
 * "these are all the drivers there are", and confirmation is the frames that follow it.
 */
export function dropUnconfirmed(
  drivers: Map<string, DriverStatus>,
  confirmed: ReadonlySet<string>,
): Map<string, DriverStatus> {
  const next = new Map<string, DriverStatus>()
  for (const [id, status] of drivers) if (confirmed.has(id)) next.set(id, status)
  // The same map back when nothing went, so a sweep that finds nothing stale does not
  // re-render every consumer of the fleet.
  return next.size === drivers.size ? drivers : next
}

/**
 * Fold one driver status into the map.
 *
 * The server keeps neither ending: its registry drops the driver on 'exited' and on 'error'
 * alike, so by the time either status arrives there is no process behind it and no endpoint
 * that will act on it. The two are still folded in differently, and the difference is about
 * what is left to say. An exit says nothing a reader needs, while an entry that outlives it
 * is what leaves a composer offering a stop button and a queue count for a process that no
 * longer exists, so it goes. An 'error' carries a detail that is the only account of why the
 * driver died — and 'error' is the ending nearly every driver takes, because stopping one
 * sends SIGTERM and a signal death is not a clean exit — so it is kept on purpose, knowingly
 * outliving the server's own record of it.
 *
 * What makes keeping it safe is that the page asks the state and not the presence: the
 * composer's `driven` excludes 'exited' and 'error', so a kept entry shows its error and
 * nothing else on the page still believes aivis is holding the session's standard input.
 * Narrowing that check back to `driver !== undefined` would have to be paired with deleting
 * on 'error' here, or the stale-entry bug this rule exists for comes straight back.
 */
export function applyDriverStatus(
  drivers: Map<string, DriverStatus>,
  status: DriverStatus,
): Map<string, DriverStatus> {
  const next = new Map(drivers)
  if (status.state === 'exited') next.delete(status.sessionId)
  else next.set(status.sessionId, status)
  return next
}

/**
 * Keep a live map of every session, fed by the server's WebSocket.
 *
 * The socket sends a full snapshot on connect and incremental updates afterwards, so
 * sessions are held in a map and merged by id. A dropped connection retries on a fixed
 * delay, and the next snapshot replaces whatever the client had — the drivers included,
 * because a daemon that has been restarted drives none of the sessions the one before it
 * did, and says so only by not mentioning them again.
 */
export function useFleet(): {
  sessions: Session[]
  connection: ConnectionState
  drivers: Map<string, DriverStatus>
} {
  const [sessions, setSessions] = useState<Map<string, Session>>(new Map())
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [drivers, setDrivers] = useState<Map<string, DriverStatus>>(new Map())
  const socketRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    let closed = false
    let retry: ReturnType<typeof setTimeout> | null = null
    let sweep: ReturnType<typeof setTimeout> | null = null
    /** Sessions a driver status has arrived for since the last snapshot. */
    let confirmed = new Set<string>()

    const connect = (): void => {
      if (closed) return
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
      const socket = new WebSocket(`${protocol}://${location.host}/ws`)
      socketRef.current = socket
      setConnection('connecting')

      socket.onopen = () => setConnection('open')
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data as string) as ServerMessage
        if (message.kind === 'driver') {
          confirmed.add(message.status.sessionId)
          setDrivers((previous) => applyDriverStatus(previous, message.status))
          return
        }
        if (message.kind === 'snapshot') {
          // A snapshot is the client starting over, and the drivers start over with it —
          // but only once the statuses the server sends straight after it have had time to
          // land, so that a page reconnecting to the same daemon never sees its own answer
          // card blink out and back.
          confirmed = new Set()
          if (sweep) clearTimeout(sweep)
          sweep = setTimeout(() => {
            sweep = null
            setDrivers((previous) => dropUnconfirmed(previous, confirmed))
          }, SNAPSHOT_SWEEP_MS)
        }
        setSessions((previous) => {
          const next = message.kind === 'snapshot' ? new Map<string, Session>() : new Map(previous)
          if (message.kind === 'removed') {
            for (const id of message.ids) next.delete(id)
          } else {
            for (const session of message.sessions) next.set(session.id, session)
          }
          return next
        })
      }
      socket.onclose = () => {
        setConnection('closed')
        if (!closed) retry = setTimeout(connect, 1500)
      }
      socket.onerror = () => socket.close()
    }

    connect()
    return () => {
      closed = true
      if (retry) clearTimeout(retry)
      if (sweep) clearTimeout(sweep)
      socketRef.current?.close()
    }
  }, [])

  const list = [...sessions.values()].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  return { sessions: list, connection, drivers }
}
