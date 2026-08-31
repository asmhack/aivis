import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addressable, hostnameOf, readsAsJson, sameOrigin, type OriginPolicy } from '../server/origin.ts'

/*
 * `sameOrigin` is the only thing standing between aivis and any page you happen to have
 * open: it guards every HTTP route and the WebSocket handshake, and behind it are routes
 * that start `claude` in any directory, answer permission prompts, and hand back every
 * prompt in every transcript. SECURITY.md states the rule as a table of Host against
 * Origin; the cases below are that table, so a refactor that widens it fails here rather
 * than in someone's browser.
 */

/** The default bind, and the one the rules are strictest for. */
const LOOPBACK: OriginPolicy = { host: '127.0.0.1', allowedHosts: [] }

/** A deliberate outward bind, where the Host half of the check is dropped. */
const LAN: OriginPolicy = { host: '192.168.1.20', allowedHosts: [] }

/** Loopback, reached under a name only `AIVIS_ALLOWED_HOSTS` knows about. */
const NAMED: OriginPolicy = { host: '127.0.0.1', allowedHosts: ['aivis.tail-scale.ts.net'] }

test('a request with no Origin is allowed, because that is what curl and the probe scripts send', () => {
  assert.equal(sameOrigin({ host: '127.0.0.1:4319' }, LOOPBACK), true)
  assert.equal(sameOrigin({ host: 'localhost:4319' }, LOOPBACK), true)
})

/*
 * The one case worth stating at length. `Origin: null` is not what a client with no origin
 * sends — that client sends no header at all. It is what a browser sends for an *opaque*
 * origin: a `<iframe sandbox="allow-scripts">`, a `data:` or `file:` document, a request
 * that followed a cross-site redirect. Every one of those is a page, and a page is the
 * exact thing this check exists to refuse. Treating the string as a missing header let any
 * site drive the API and read the fleet from a sandboxed iframe.
 */
test('a present `Origin: null` is refused, because only a page has an opaque origin', () => {
  assert.equal(sameOrigin({ host: '127.0.0.1:4319', origin: 'null' }, LOOPBACK), false)
  assert.equal(sameOrigin({ host: 'localhost:4319', origin: 'null' }, LOOPBACK), false)
  assert.equal(sameOrigin({ host: '[::1]:4319', origin: 'null' }, LOOPBACK), false)
  assert.equal(sameOrigin({ host: 'aivis.tail-scale.ts.net', origin: 'null' }, NAMED), false)
  // Dropping the Host check does not soften it either: an opaque origin matches no name.
  assert.equal(sameOrigin({ host: '192.168.1.20:4319', origin: 'null' }, LAN), false)
})

test('a page on another site is refused however it reaches the port', () => {
  assert.equal(sameOrigin({ host: '127.0.0.1:4319', origin: 'http://evil.com' }, LOOPBACK), false)
  assert.equal(sameOrigin({ host: 'localhost:4319', origin: 'https://evil.com' }, LOOPBACK), false)
  // A name that merely contains one aivis answers to is still another name.
  assert.equal(sameOrigin({ host: '127.0.0.1:4319', origin: 'http://127.0.0.1.evil.com' }, LOOPBACK), false)
  assert.equal(sameOrigin({ host: '127.0.0.1:4319', origin: 'http://localhost.evil.com' }, LOOPBACK), false)
})

/*
 * DNS rebinding: an attacker can point a name they control at 127.0.0.1, and the browser
 * will then send that name in `Host`. Refusing a Host aivis does not answer to is what
 * stops it, and it is the half of the check that a loopback bind can afford.
 */
test('a loopback bind refuses a Host it does not answer to, which is what defeats DNS rebinding', () => {
  assert.equal(sameOrigin({ host: 'aivis.example.com' }, LOOPBACK), false)
  assert.equal(sameOrigin({ host: 'aivis.example.com:4319' }, LOOPBACK), false)
  assert.equal(
    sameOrigin({ host: 'aivis.example.com:4319', origin: 'http://aivis.example.com:4319' }, LOOPBACK),
    false,
    'the Host half is checked first, so a matching Origin does not rescue it',
  )
  assert.equal(sameOrigin({ host: '127.0.0.1:4319' }, LOOPBACK), true)
})

/*
 * An operator who binds outward is reached under a name aivis cannot predict, so the Host
 * half is dropped and `Origin` matching `Host` is what says the page came from this server.
 * SECURITY.md names the cost of that openly: DNS rebinding is not defended against on a
 * non-loopback bind. This pins the trade rather than pretending it away.
 */
test('a non-loopback bind serves its own pages, because an Origin equal to Host says they are its own', () => {
  assert.equal(sameOrigin({ host: '192.168.1.20:4319', origin: 'http://192.168.1.20:4319' }, LAN), true)
  assert.equal(sameOrigin({ host: 'box.local:4319', origin: 'http://box.local:4319' }, LAN), true)
  assert.equal(sameOrigin({ host: 'box.local:4319' }, LAN), true, 'the Host half is not checked at all')
  assert.equal(sameOrigin({ host: 'box.local:4319', origin: 'http://evil.com' }, LAN), false)
})

test('a name from AIVIS_ALLOWED_HOSTS is answered to in both headers', () => {
  assert.equal(
    sameOrigin({ host: 'aivis.tail-scale.ts.net', origin: 'http://aivis.tail-scale.ts.net' }, NAMED),
    true,
  )
  assert.equal(sameOrigin({ host: 'aivis.tail-scale.ts.net:4319' }, NAMED), true)
  // Loopback still works while the extra name is configured, and a stranger still does not.
  assert.equal(sameOrigin({ host: '127.0.0.1:4319', origin: 'http://127.0.0.1:4319' }, NAMED), true)
  assert.equal(sameOrigin({ host: 'aivis.tail-scale.ts.net', origin: 'http://evil.com' }, NAMED), false)
  assert.equal(sameOrigin({ host: 'aivis.example.com' }, LOOPBACK), false)
})

test('a port and IPv6 brackets are stripped, so `[::1]:4000` is compared as the name it is', () => {
  assert.equal(hostnameOf('[::1]:4000'), '::1')
  assert.equal(hostnameOf('127.0.0.1:4319'), '127.0.0.1')
  assert.equal(hostnameOf('LocalHost:4319'), 'localhost')
  assert.equal(addressable(hostnameOf('[::1]:4000'), LOOPBACK), true)
  assert.equal(sameOrigin({ host: '[::1]:4000', origin: 'http://[::1]:4000' }, LOOPBACK), true)
  assert.equal(sameOrigin({ host: '[::1]:4000', origin: 'http://evil.com' }, LOOPBACK), false)
  assert.equal(sameOrigin({ host: '[::1]:4000' }, { host: '::1', allowedHosts: [] }), true)
})

test('an Origin that is not a URL is refused rather than guessed at', () => {
  assert.equal(sameOrigin({ host: '127.0.0.1:4319', origin: 'not a url' }, LOOPBACK), false)
  assert.equal(sameOrigin({ host: '127.0.0.1:4319', origin: 'http://' }, LOOPBACK), false)
  assert.equal(sameOrigin({ host: '127.0.0.1:4319', origin: '127.0.0.1:4319' }, LOOPBACK), false)
  // Two Origin headers arrive joined, and a pair is not a single origin aivis answers to.
  assert.equal(sameOrigin({ host: '127.0.0.1:4319', origin: 'null, http://127.0.0.1:4319' }, LOOPBACK), false)
})

/*
 * The other half of the browser boundary. `sameOrigin` decides which page may speak at all;
 * this decides whether a request could have been sent without the browser asking permission
 * first. The three types below are the CORS "simple request" safelist: a page on any other
 * site can send one cross-origin with no preflight, and a POST carrying no body sends no
 * type at all. `application/json` is not on that list, so demanding it means a cross-site
 * attempt has to survive a preflight this server never answers.
 */
test('only application/json is accepted, so a cross-site POST cannot stay a simple request', () => {
  assert.equal(readsAsJson('application/json'), true)
  assert.equal(readsAsJson('application/json; charset=utf-8'), true)
  assert.equal(readsAsJson('  APPLICATION/JSON  '), true, 'the type is case- and space-insensitive')
  // The safelisted three, which are the whole reason this check exists.
  assert.equal(readsAsJson('text/plain'), false)
  assert.equal(readsAsJson('text/plain;charset=UTF-8'), false)
  assert.equal(readsAsJson('application/x-www-form-urlencoded'), false)
  assert.equal(readsAsJson('multipart/form-data; boundary=x'), false)
  // A POST with no body of its own sends no type at all — the shape `/stop` and
  // `/interrupt` are reached with — and a `Blob` with no type does the same.
  assert.equal(readsAsJson(undefined), false)
  assert.equal(readsAsJson(''), false)
  // A near miss is another type, not this one.
  assert.equal(readsAsJson('application/json-patch+json'), false)
  assert.equal(readsAsJson('text/json'), false)
})

/*
 * Where these rules are applied — the HTTP handler, the WebSocket handshake, the framing
 * headers on every answer — is checked in `test/index.test.ts`, which imports the real
 * handler and sends requests through it. It used to be checked here by regex-matching the
 * text of `server/index.ts`, which is a weaker thing than it looks: the pattern matches a
 * commented-out gate, and it matches a gate that a newly hoisted route sits above. Placement
 * is the whole of C-001 and M-006, so it is pinned by behaviour rather than by spelling.
 */
