import { useCallback, useEffect, useRef, useState } from 'react'
import type { AttentionItem } from '../shared/types.ts'
import { advance, describe, unarmed, type Notice, type NotifyState } from './notify.ts'

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
 * The decisions this makes are all in `notify.ts` and tested there. What is left here is the
 * part that needs a browser: following the permission, knowing whether you are looking, and
 * turning an item into a `Notification`.
 *
 * One thing it deliberately does not claim to know is whether a banner was ever drawn. The
 * browser reports that it showed one even where there is no screen to show it on, so a system
 * configured to give the browser no banner produces silence that is indistinguishable, from
 * here, from code that never ran. That is why `raised` is counted and reported, why `test`
 * exists, and why the count on the tab (`useBadge.ts`) is the signal this feature actually
 * rests on rather than a decoration on top of it.
 */

/** Where the choice is remembered, so a reload does not silently turn banners back off. */
const PREF_KEY = 'aivis.notify'

/**
 * The banner sent when notifications are switched on, and again by the test button.
 *
 * One notice for both, because they are the same errand: show the reader, right now, what a
 * banner from aivis looks like, so that a screen which stays empty is a fact about their
 * system rather than a question about this feature.
 *
 * The tag counts, for the reason given on `Notice.tag`: a fixed one meant the second greeting
 * silently replaced the first, so switching notifications off and on again to check whether
 * they worked was guaranteed to show nothing — which is exactly what someone does when they
 * suspect the feature is broken.
 */
function hello(n: number): Notice {
  return {
    title: 'aivis will tell you',
    body: 'When a session asks you something or finishes its turn, it shows up here.',
    tag: `aivis:hello:${n}`,
  }
}

/**
 * How many raised banners are held on to.
 *
 * A `Notification` with nothing referencing it is collectable, and a browser that collects
 * one before the operating system has drawn it makes it vanish for no reason a reader could
 * ever work out. Holding the last few costs nothing and closes that off.
 */
const HELD = 8

/** The toggle, and enough about its state for the page to say why it is off. */
export interface Notifier {
  /** False where the API is absent, which on a page served over plain http to a LAN address it is. */
  supported: boolean
  /** On, meaning both asked for and granted. */
  enabled: boolean
  /** The browser's answer to the permission prompt, or null where there is no API to ask. */
  permission: NotificationPermission | null
  /**
   * How many banners this page has handed to the browser since it loaded.
   *
   * On screen because it is the only part of the chain aivis can honestly report. Everything
   * after the call belongs to the browser and the operating system, and neither says whether
   * the banner was ever shown, so a reader who saw nothing needs to know whether there was
   * anything to see. A count that climbs while the screen stays empty names the culprit.
   */
  raised: number
  /** Flip it, returning the line to show you about what happened. */
  toggle: () => Promise<string>
  /**
   * Raise one now, so the path can be checked without waiting for a session to need you.
   *
   * The wait for a real one is unbounded, which made every failure look the same as patience.
   */
  test: () => string
}

/**
 * Post one banner.
 *
 * `renotify` is belt and braces against the failure this feature has already had once.
 * Replacing a notification that shares a tag with a live one is defined to happen *quietly*,
 * and nothing anywhere reports that it happened, so a collision reads exactly like code that
 * never ran. Tags are unique per event now (see `Notice.tag`) and no replacement should ever
 * occur — but if one somehow did, this makes it announce itself rather than vanish. It is
 * invalid without a tag, which every notice carries.
 */
function post(notice: { title: string; body: string; tag: string }): Notification {
  return new Notification(notice.title, {
    body: notice.body,
    tag: notice.tag,
    renotify: true,
  } as NotificationOptions & { renotify: boolean })
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

  // What was asked for is kept apart from what is allowed, and both must agree before anything
  // is raised. Permission is the browser's to withdraw — through site settings, or a sweep of
  // permissions a site has not used lately — and it withdraws it without telling the page.
  const enabled = supported && wanted && permission === 'granted'

  // So the permission is followed rather than snapshotted. Read once at mount, the pill goes
  // on reading "notifications on" over a browser that has quietly stopped honouring the
  // calls, which is the most misleading thing this control could say.
  useEffect(() => {
    if (!supported || !navigator.permissions?.query) return
    let status: PermissionStatus | null = null
    const follow = (): void => setPermission(Notification.permission)
    void navigator.permissions
      .query({ name: 'notifications' as PermissionName })
      .then((result) => {
        status = result
        result.addEventListener('change', follow)
        follow()
      })
      .catch(() => {
        // A browser that will not report on this permission still answers
        // `Notification.permission`, which is what the toggle re-reads anyway.
      })
    return () => status?.removeEventListener('change', follow)
  }, [supported])

  const want = useCallback((next: boolean): void => {
    setWanted(next)
    try {
      localStorage.setItem(PREF_KEY, next ? 'on' : 'off')
    } catch {
      // Storage that refuses to write just means the choice lasts this session only.
    }
  }, [])

  const [raised, setRaised] = useState(0)
  const held = useRef<Notification[]>([])
  // Counted in a ref as well as in state, because the greeting's tag is built from it and has
  // to be distinct on the same tick that raises it, before a render could have caught up.
  const count = useRef(0)

  /**
   * Hand one banner to the browser, count it, and keep hold of it.
   *
   * The count is what the page reports, and it counts calls rather than banners seen — which
   * is the honest thing to count, because nothing downstream of here reports back.
   */
  const raise = useCallback((notice: Notice): Notification | null => {
    try {
      const banner = post(notice)
      held.current = [...held.current.slice(-(HELD - 1)), banner]
      count.current += 1
      setRaised(count.current)
      return banner
    } catch {
      // A browser that throws on the constructor has told the reader nothing, so neither is
      // this counted. Everything else on the page carries on.
      return null
    }
  }, [])

  const toggle = useCallback(async (): Promise<string> => {
    if (!supported) {
      return 'this browser offers no notifications to this page — they need https, or a loopback address like localhost or 127.0.0.1'
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
    raise(hello(count.current))
    return 'notifications on'
  }, [supported, wanted, want, raise])

  const test = useCallback((): string => {
    if (!supported) return 'this browser has no notifications to test'
    if (Notification.permission !== 'granted') return 'notifications are not switched on'
    raise(hello(count.current))
    // Deliberately not "sent". aivis knows only that the browser accepted it, and the whole
    // reason this button exists is that the two are not the same thing.
    return 'notification raised — if nothing appeared, your system is suppressing it'
  }, [supported, raise])

  // Kept in a ref so that changing how a click is handled does not re-run the effect below
  // and re-arm it, which would swallow whatever arrived in between.
  const open = useRef(onOpen)
  useEffect(() => {
    open.current = onOpen
  }, [onOpen])

  // What has been announced and whether a baseline has been taken. The rules that read it are
  // in `notify.ts` and tested there; what is left here is the part that needs a browser.
  const state = useRef<NotifyState>(unarmed())

  useEffect(() => {
    const step = advance(state.current, items, enabled && loaded, looking(), openSessionId)
    state.current = step.state

    for (const item of step.announce) {
      const banner = raise(describe(item))
      if (!banner) continue
      banner.onclick = () => {
        // Clicking a banner is a request to deal with the session it names, so the window
        // comes forward and the page is already on that session when it does.
        window.focus()
        open.current(item.sessionId)
        banner.close()
      }
    }
  }, [enabled, loaded, items, openSessionId, raise])

  return { supported, enabled, permission, raised, toggle, test }
}
