import { useEffect } from 'react'
import type { AttentionItem } from '../shared/types.ts'
import { badgeText, needing, titleFor } from './badge.ts'

/**
 * Wear the attention count on the tab.
 *
 * Three places, in decreasing order of how reliable they are. The title always works and is
 * visible wherever a tab is. The icon is drawn here rather than shipped as a file, because it
 * has to carry a number that changes; it is what you see when the tab is pinned or the strip
 * is too crowded for a title. The app badge is the operating system's own dot on a dock icon,
 * which only exists for an installed app and is skipped silently everywhere else.
 *
 * None of it needs a permission, and nothing outside the page can suppress any of it. That is
 * the entire point: see `badge.ts` for why a notification alone is not enough.
 */

/** The title as the document was served with it, before any count was put in front of it. */
const BASE_TITLE = typeof document === 'undefined' ? 'aivis' : document.title

/** Where the drawn icon is installed, made once and then re-pointed at each new drawing. */
function iconLink(): HTMLLinkElement {
  const existing = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (existing) return existing
  const link = document.createElement('link')
  link.rel = 'icon'
  document.head.appendChild(link)
  return link
}

/**
 * Draw the favicon for a count.
 *
 * A filled rounded square, warm when something is waiting and grey when nothing is, with the
 * count over it. Sixteen logical pixels drawn at 32 so it stays sharp on a retina screen.
 * Returns a data URL, which the page's `img-src 'self' data: blob:` policy allows.
 */
function drawIcon(count: number): string | null {
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 32
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const warm = count > 0
  ctx.fillStyle = warm ? '#f0b27a' : '#5f6b7a'
  ctx.beginPath()
  ctx.roundRect(2, 2, 28, 28, 8)
  ctx.fill()

  const text = badgeText(count)
  if (text) {
    ctx.fillStyle = '#0e1116'
    ctx.font = 'bold 20px ui-monospace, Menlo, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, 16, 17)
  }
  return canvas.toDataURL('image/png')
}

export function useBadge(items: AttentionItem[]): void {
  const count = needing(items)

  useEffect(() => {
    document.title = titleFor(count, BASE_TITLE)

    try {
      const url = drawIcon(count)
      if (url) iconLink().href = url
    } catch {
      // A browser without canvas, or one that refuses to export it, still has the title.
    }

    // Only an installed app has a dock icon to badge, and every other browser either lacks
    // the method or rejects the promise. Neither is worth reporting: this is the third of
    // three signals and the two above it have already landed.
    const badging = navigator as Navigator & {
      setAppBadge?: (n?: number) => Promise<void>
      clearAppBadge?: () => Promise<void>
    }
    if (count > 0) void badging.setAppBadge?.(count).catch(() => {})
    else void badging.clearAppBadge?.().catch(() => {})
  }, [count])
}
