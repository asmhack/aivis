import type { IncomingHttpHeaders } from 'node:http'

/**
 * Where aivis can be reached, which is everything the origin gate needs to know.
 *
 * The rules below take this rather than reading `config` themselves, so the Host/Origin
 * table `SECURITY.md` documents can be exercised for binds this process is not running on
 * — a LAN address, a Tailscale name from `AIVIS_ALLOWED_HOSTS` — without having to set
 * environment variables and re-import a module to change them.
 */
export type OriginPolicy = {
  /** The address aivis is bound to, as `AIVIS_HOST` gives it. */
  host: string
  /** Extra hostnames the browser may reach aivis on, already lowercased. */
  allowedHosts: string[]
}

/**
 * Names that mean "this machine". `0.0.0.0` is deliberately absent: it is a bind address
 * rather than an address a client uses, and treating it as local would both suppress the
 * exposure warning at startup and make a LAN bind refuse its own pages.
 */
export const LOCAL_NAMES = new Set(['127.0.0.1', 'localhost', '::1'])

/** Strip the port and any IPv6 brackets, leaving a bare hostname to compare. */
export function hostnameOf(value: string): string {
  return value.replace(/:\d+$/, '').toLowerCase().replace(/^\[|\]$/g, '')
}

/** Whether a hostname is one aivis is willing to be addressed as. */
export function addressable(hostname: string, policy: OriginPolicy): boolean {
  return (
    LOCAL_NAMES.has(hostname) ||
    hostname === policy.host.toLowerCase() ||
    policy.allowedHosts.includes(hostname)
  )
}

/**
 * One header value as a single string.
 *
 * Node hands back an array only for headers it is told may repeat, but a client controls
 * what it sends, and a value this cannot reduce to one of the exact tokens below — a
 * spliced `cross-site, none`, an array — must end up refused rather than skipped.
 */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(',') : value
}

/**
 * Refuse requests that did not come from a page aivis is served on.
 *
 * There is no authentication here, and the endpoints this guards start processes, read any
 * file the user can read, and hand back every prompt in every transcript. A browser will
 * happily let any site you visit issue requests to `127.0.0.1`, so without this check a
 * page in another tab could drive your sessions and read your history. Two headers close
 * that: `Origin` names the page that made the request, and `Host` names the address it was
 * sent to.
 *
 * On the default loopback bind the `Host` must be a name that means this machine, which is
 * what defeats DNS rebinding — an attacker can point `aivis.example.com` at 127.0.0.1, but
 * the browser then sends that name in `Host` and it does not match. On a deliberate
 * non-loopback bind that check is dropped, because the operator is reached under a name
 * aivis cannot predict; `Origin` is still required to match the address the request was
 * sent to, so a foreign page is refused either way.
 *
 * A missing `Origin` is allowed. That is what `curl`, the probe scripts in `scripts/`, and
 * every non-browser client send, and the threat being closed is a web page — a local
 * process that wanted the transcripts could read `~/.claude/projects` directly.
 *
 * A present `Origin: null` is a different thing entirely and is refused. No non-browser
 * client sends it; it is precisely what a browser sends for an opaque origin — a sandboxed
 * iframe, a `data:` or `file:` document, a request that followed a cross-site redirect.
 * Those are pages, and pages are what this exists to stop, so `null` falls through to the
 * URL parse below and fails it.
 *
 * `Sec-Fetch-Site` is checked as well, because a page can reach a `GET` route without ever
 * sending an `Origin` — see the comment on that check below.
 */
export function sameOrigin(headers: IncomingHttpHeaders, policy: OriginPolicy): boolean {
  const host = hostnameOf(headers.host ?? '')
  if (LOCAL_NAMES.has(policy.host.toLowerCase()) && !addressable(host, policy)) return false

  // A browser only sends `Origin` on requests a page could read the answer to — a POST, a
  // `fetch()`. A plain subresource load sends none, so `<img src="http://127.0.0.1:4319/
  // api/projects/branches?cwd=/some/repo">` on any site in any open tab arrives here with
  // nothing for the rule above to refuse it on, and aivis runs `git status` in a directory
  // that page chose. The answer is unreadable cross-origin, but the process still ran, and
  // a page full of such tags runs as many as it likes.
  //
  // `Sec-Fetch-Site` closes that. Browsers send it on every request whatever the origin
  // rules are (Chrome since 76, Firefox since 90, Safari since 16.4) and it says what the
  // page was relative to this server even when `Origin` is absent. `cross-site` is exactly
  // the case the `Origin` rule refuses whenever it can see it, so it is refused here too.
  // `none` — a typed URL, a bookmark, a link opened from a terminal — and `same-origin` /
  // `same-site` — aivis's own pages, and the Vite dev server on another port — are the
  // cases that must keep working. A client that sends no fetch metadata at all is left
  // alone: `curl`, the probe scripts in `scripts/`, and a browser old enough to predate
  // the header get the `Origin`-only rule they got before.
  //
  // A top-level navigation is the one cross-site case still allowed. Refusing it would
  // turn a link pointing at your own aivis into a 403, and unlike a subresource it is not
  // silent: it takes the tab off the attacker's page and shows the user what came back. An
  // `<iframe>` is `sec-fetch-dest: iframe` rather than `document`, so framing stays
  // refused, and a cross-site form POST is caught by the `Origin` check below anyway.
  const site = headerValue(headers['sec-fetch-site'])
  if (site && site !== 'same-origin' && site !== 'same-site' && site !== 'none') {
    const navigating =
      headerValue(headers['sec-fetch-mode']) === 'navigate' &&
      headerValue(headers['sec-fetch-dest']) === 'document'
    if (!navigating) return false
  }

  const origin = headers.origin
  if (!origin) return true
  let from: string
  try {
    from = hostnameOf(new URL(origin).hostname)
  } catch {
    return false
  }
  // Either a name aivis answers to, or the very address this request was sent to — which
  // is what lets a LAN or Tailscale bind serve its own pages without being configured.
  return addressable(from, policy) || from === host
}

/**
 * Whether a request body is offered as something aivis reads.
 *
 * Only `application/json`, with an optional charset or other parameter. Nothing else
 * qualifies, not even a missing header, and that is the whole point of the check: a
 * cross-site `fetch` may send `text/plain`, `application/x-www-form-urlencoded` or
 * `multipart/form-data` with no CORS preflight, a `Blob` body with no type of its own is
 * sent with no `Content-Type` at all, and a POST with no body at all sends none either.
 * Accepting any of those would leave the state-changing routes reachable as a plain simple
 * request, with the origin check as the only thing between a page you happen to visit and
 * a started or stopped process — and that check deliberately trusts every loopback origin
 * whatever its port, so any other local server's page would pass it. `application/json` is
 * not on the safelist, so demanding it forces a cross-site attempt into a preflight this
 * server never answers. Non-browser clients are unaffected: `curl` sends the header when
 * asked to.
 *
 * This lives beside `sameOrigin` rather than beside the body reader because it is the same
 * kind of rule — what the browser boundary lets through — and `server/index.ts` applies it
 * to every POST, including the ones that act on a session without reading a body.
 */
export function readsAsJson(contentType: string | undefined): boolean {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() === 'application/json'
}
