/**
 * Where a markdown image points, decided before anything is rendered.
 *
 * Assistant text is written by a model that may be repeating an instruction it read in a
 * web page or a repository file, so `![](https://somewhere/x.png?d=…)` in a reply is not a
 * picture the user asked for — it is a request the page would make on their behalf the
 * moment the transcript is drawn, carrying whatever the address hid in it. That is why the
 * classification lives here rather than inline in the component: it is the whole of the
 * defence, it is three regular expressions that read as harmless, and a module with no DOM
 * in it can be pinned by tests that run in the same plain node harness as everything else.
 */

/**
 * What a source turned out to be.
 *
 * - `served` — already on this machine and safe to put in an `<img>` as it stands: a
 *   `data:` image carries its own bytes and reaches nothing, and `/api/` is aivis serving
 *   the session back to its own page.
 * - `elsewhere` — names some other origin, whether by scheme or in the protocol-relative
 *   `//host/path` form. Never fetched.
 * - `path` — everything left, which is treated as a file path and wrapped in a same-origin
 *   `/localfile` URL by the caller. A source too strange to classify lands here, so it
 *   still cannot turn into a request that leaves the machine.
 */
export type ImageSourceKind = 'served' | 'elsewhere' | 'path'

export interface ImageSource {
  kind: ImageSourceKind
  /** The source as a browser would read it, with surrounding space removed. */
  target: string
  /**
   * Whether the address is worth offering as a link the reader can follow themselves.
   *
   * Only a web address is. A `file:` or `javascript:` source is not something a click
   * should follow, so it is left as the text it is.
   */
  followable: boolean
}

export function classifyImageSource(src: string): ImageSource {
  // Surrounding space is not part of an address to a browser, so the scheme is read from
  // where the browser would read it rather than from the first character of the source.
  const target = src.trim()

  if (/^data:image\//i.test(target) || target.startsWith('/api/')) {
    return { kind: 'served', target, followable: false }
  }

  if (/^[a-z][a-z0-9+.-]+:/i.test(target) || target.startsWith('//')) {
    return { kind: 'elsewhere', target, followable: /^https?:/i.test(target) }
  }

  return { kind: 'path', target, followable: false }
}
