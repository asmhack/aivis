import { useCallback, useEffect, useRef, useState } from 'react'
import type { AttentionItem } from '../shared/types.ts'
import { arrivals, describe, onScreen, remember } from './notify.ts'

/**
 * Raise a system notification when a session starts needing you.
 *
 * The fleet page tells you what needs you while you are reading it, and this says the same
 * thing while you are not: the banner goes to the operating system's notification centre,
 * where it waits with everything else that happened while you were in another window. It
 * is the browser doing the delivering, so the aivis tab has to be open — this is a page
 * asking to speak, not a server pushing to a device — and everything about how the banner
 * looks and how long it stays belongs to the browser and the operating system rather than
 * to aivis.
 *
 * The decisions this makes are all in `notify.ts` and tested there. What is left here is
 * the part that needs a browser: asking permission once, knowing whether you are looking,
 * and turning an item into a `Notification`.
 */

/** Where the choice is remembered, so a reload does not silently turn banners back off. */
const PREF_KEY = 'aivis.notify'

/** The toggle, and enough about its state for the page to say why it is off. */
export interface Notifier {
  /** False where the API is absent, which on a page served over plain http to a LAN address it is. */
  supported: boolean
  /** On, meaning both asked for and granted. */
  enabled: boolean
  /** The browser's answer to the permission prompt, or null where there is no API to ask. */
  permission: NotificationPermission | null
  /** Flip it, returning the line to show you about what happened. */
  toggle: () => Promise<string>
}

/** Whether this page is the one you are looking at right now. */
function looking(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

export function useNotify(
  items: AttentionItem[],
  /** False until the first queue has been fetched, so an empty queue is not mistaken for a quiet one. */
  loaded: boolean,
  openSessionId: string | null,
  onOpen: (sessionId: string) => void,
): Notifier {
  const supported = typeof window !== 'undefined' && 'Notification' in window
  const [permission, setPermission] = useState<NotificationPermission | null>(
    supported ? Notification.permission : null,
  )
  const [wanted, setWanted] = useState(() => {
    try {
      return localStorage.getItem(PREF_KEY) === 'on'
    } catch {
      return false
    }
  })

  // Permission is the browser's to withdraw, and it does so without telling the page, so
  // what was asked for is kept separately from what is allowed and the two are required to
  // agree before anything is raised.
  const enabled = supported && wanted && permission === 'granted'

  const want = useCallback((next: boolean): void => {
    setWanted(next)
    try {
      localStorage.setItem(PREF_KEY, next ? 'on' : 'off')
    } catch {
      // Storage that refuses to write just means the choice lasts this session only.
    }
  }, [])

  const toggle = useCallback(async (): Promise<string> => {
    if (!supported) {
      return 'this browser will not show notifications on this page — they need https or localhost'
    }
    if (wanted) {
      want(false)
      return 'notifications off'
    }
    // Safari will only open the prompt from a gesture, which is why this is on a button and
    // not asked for on load. Asking when already answered is harmless and returns the answer.
    const answer = await Notification.requestPermission()
    setPermission(answer)
    if (answer !== 'granted') {
      want(false)
      return answer === 'denied'
        ? 'your browser is blocking notifications for this page — allow them in its site settings'
        : 'notifications need permission, and the prompt was dismissed'
    }
    want(true)
    // Proof the whole path works, sent the moment it is switched on. Without it the next
    // banner may be an hour away and there is no way to tell "waiting" from "broken".
    new Notification('aivis will tell you', {
      body: 'When a session asks you something or finishes its turn, it shows up here.',
      tag: 'aivis:hello',
    })
    return 'notifications on'
  }, [supported, wanted, want])

  // Kept in a ref so that changing how a click is handled does not re-run the effect below
  // and re-arm it, which would swallow whatever arrived in between.
  const open = useRef(onOpen)
  useEffect(() => {
    open.current = onOpen
  }, [onOpen])

  const seen = useRef<Set<string>>(new Set())
  const armed = useRef(false)

  useEffect(() => {
    if (!enabled || !loaded) {
      // Off, or nothing fetched yet. Either way there is no baseline to compare against,
      // so the next pass has to start one rather than treat the whole queue as news.
      armed.current = false
      seen.current = new Set()
      return
    }

    const fresh = arrivals(items, seen.current)
    seen.current = remember(seen.current, items)

    // The queue as it stood when you switched notifications on is the state of the world,
    // not news. Announcing it would mean a burst of banners for waits you already knew
    // about every time the page reloads.
    if (!armed.current) {
      armed.current = true
      return
    }

    for (const item of fresh) {
      // Marked as announced above whether or not a banner is raised: an item that arrived
      // on the session page you were reading has been watched, and telling you about it
      // later — once you have tabbed away and it is no longer new — is worse than silence.
      if (looking() && onScreen(item, openSessionId)) continue
      const notice = describe(item)
      const banner = new Notification(notice.title, { body: notice.body, tag: notice.tag })
      banner.onclick = () => {
        // Clicking a banner is a request to deal with the session it names, so the window
        // comes forward and the page is already on that session when it does.
        window.focus()
        open.current(item.sessionId)
        banner.close()
      }
    }
  }, [enabled, loaded, items, openSessionId])

  return { supported, enabled, permission, toggle }
}
