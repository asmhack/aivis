import { useCallback, useEffect, useState } from 'react'
import { SessionPage } from './components/SessionPage.tsx'
import { MissionControl } from './components/MissionControl.tsx'
import { useFleet } from './useFleet.ts'
import { preferredQueue, useAttention } from './useAttention.ts'
import { useNotify } from './useNotify.ts'
import { useBadge } from './useBadge.ts'
import { NewSessionSheet } from './components/NewSessionSheet.tsx'

/** Read the session id out of the current path, or null on the fleet page. */
function routeSessionId(pathname: string): string | null {
  const match = pathname.match(/^\/session\/(.+)$/)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

/**
 * The whole client: an index of the fleet, one session at a time behind a real route,
 * and the new-session sheet that either of them can raise.
 */
export function App(): React.JSX.Element {
  const { sessions, connection, drivers, attention: pushed } = useFleet()
  const [openId, setOpenId] = useState<string | null>(() => routeSessionId(location.pathname))

  // The attention queue is held up here rather than inside the index, because what it feeds —
  // notifications and the count on the tab — has to keep working while you are reading a
  // session, which is the one place the queue itself is invisible.
  //
  // It arrives over the fleet socket, and is polled only while it is not. Push is what makes
  // the feature work at all in the case it exists for: a browser throttles a hidden tab's
  // timers to roughly once a minute and may stop running them entirely, so a queue that is
  // polled is at its slowest exactly when the tab is in the background and being told is the
  // whole point. The poll stays for a server too old to push and for a socket that has
  // dropped, neither of which may be allowed to look like a fleet that needs nothing.
  const socketOpen = connection === 'open'
  const { items: polled, loaded: polledLoaded, reload: reloadAttention } = useAttention(
    socketOpen && pushed !== null,
  )
  const { items: attention, loaded: attentionLoaded } = preferredQueue(
    pushed,
    socketOpen,
    polled,
    polledLoaded,
  )

  // The count on the tab and its icon, which need no permission and cannot be suppressed by
  // anything outside this page. See web/badge.ts for why that matters more than it sounds.
  useBadge(attention)
  // null means closed; a string preselects that project, '' opens with none chosen.
  const [newFor, setNewFor] = useState<string | null>(null)

  // The session page is a real route, so the back button and a reload both work.
  useEffect(() => {
    const onPop = (): void => setOpenId(routeSessionId(location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const open = useCallback((id: string): void => {
    history.pushState({ aivis: true }, '', `/session/${encodeURIComponent(id)}`)
    setOpenId(id)
  }, [])

  const back = useCallback((): void => {
    if (history.state?.aivis) {
      history.back()
    } else {
      history.pushState({ aivis: true }, '', '/')
      setOpenId(null)
    }
  }, [])

  const notifier = useNotify(attention, attentionLoaded, openId, open)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'n' || !(event.metaKey || event.ctrlKey)) return
      const target = event.target as HTMLElement | null
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
      event.preventDefault()
      setNewFor('')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const sheet =
    newFor !== null ? (
      <NewSessionSheet
        preselected={newFor || null}
        onClose={() => setNewFor(null)}
        onStarted={(id) => {
          setNewFor(null)
          open(id)
        }}
      />
    ) : null

  if (openId !== null) {
    const session = sessions.find((s) => s.id === openId)
    return (
      <>
        {session ? (
          // Keyed by session, so moving between two of them through history remounts
          // rather than reusing the page. Everything it holds — the transcript, the open
          // rail, the scroll position and whether it is following the end — belongs to one
          // session, and carrying any of it into another is wrong in a different way each
          // time. Following the end is the one that shows: the next session opens already
          // believing the reader has scrolled away.
          <SessionPage
            key={session.id}
            session={session}
            driver={drivers.get(session.id)}
            // The page's controls act on a driver it only hears about over this socket, so
            // it has to know when the socket is down: while it is, the driver state on
            // screen is a memory rather than a report.
            connection={connection}
            onBack={back}
          />
        ) : (
          <div className="page page--message">
            <button className="page__back" onClick={back} aria-label="Back to the fleet">
              ←
            </button>
            <p className="page__loading">
              {sessions.length === 0 ? 'loading sessions…' : `No session with id ${openId}.`}
            </p>
          </div>
        )}
        {sheet}
      </>
    )
  }

  return (
    <div className="app">
      <MissionControl
        sessions={sessions}
        connection={connection}
        attention={attention}
        reloadAttention={reloadAttention}
        notifier={notifier}
        onOpen={open}
        onNew={(cwd) => setNewFor(cwd ?? '')}
      />
      {sheet}
    </div>
  )
}
