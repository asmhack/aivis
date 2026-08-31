import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sameOrigin, type OriginPolicy } from '../server/origin.ts'

/*
 * The `Origin` half of `sameOrigin` cannot see the request that matters most here. A
 * browser omits `Origin` entirely on a plain subresource load, so an `<img>` on any site
 * you have open reaches aivis's GET routes — `/api/projects/branches`, `/api/browse` —
 * looking exactly like `curl` does, and those routes spawn `git` in a directory the page
 * named. `Sec-Fetch-Site` is what distinguishes the two, and these are the cases it has to
 * get right: refuse the page, keep every non-browser client and every first-party request
 * working. They live in their own file so the SECURITY.md Host/Origin table in
 * `origin.test.ts` stays a statement of that table alone.
 */

/** The default bind, and the one these rules matter most for. */
const LOOPBACK: OriginPolicy = { host: '127.0.0.1', allowedHosts: [] }

test('a cross-site subresource is refused even though it carries no Origin', () => {
  // `<img src="http://127.0.0.1:4319/api/projects/branches?cwd=/some/repo">` on evil.example.
  assert.equal(
    sameOrigin(
      { host: '127.0.0.1:4319', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
      LOOPBACK,
    ),
    false,
  )
  // The same page framing aivis, or fetching it, or pointing a script tag at it.
  for (const dest of ['iframe', 'empty', 'script', 'style', 'object', 'embed']) {
    assert.equal(
      sameOrigin({ host: '127.0.0.1:4319', 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': dest }, LOOPBACK),
      false,
      `sec-fetch-dest: ${dest} is a page loading a subresource, not a user opening aivis`,
    )
  }
  // A frame is a navigation too, and is refused for being a frame rather than a document.
  assert.equal(
    sameOrigin(
      { host: '127.0.0.1:4319', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' },
      LOOPBACK,
    ),
    false,
  )
})

test('a client that sends no fetch metadata is unaffected', () => {
  // curl, the probe scripts in scripts/, a `ws` client, a browser predating the header:
  // all of them get exactly the Origin-only rule they got before.
  assert.equal(sameOrigin({ host: '127.0.0.1:4319' }, LOOPBACK), true)
  assert.equal(sameOrigin({ host: '127.0.0.1:4319', origin: 'http://127.0.0.1:4319' }, LOOPBACK), true)
  assert.equal(sameOrigin({ host: '127.0.0.1:4319', origin: 'http://evil.com' }, LOOPBACK), false)
})

test("aivis's own pages, and the Vite dev server, keep working", () => {
  assert.equal(
    sameOrigin(
      {
        host: '127.0.0.1:4319',
        origin: 'http://127.0.0.1:4319',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-dest': 'empty',
      },
      LOOPBACK,
    ),
    true,
  )
  // `npm run dev` serves the UI from Vite on another port and proxies /api through it, so
  // the request arrives as same-site rather than same-origin.
  assert.equal(
    sameOrigin(
      { host: 'localhost:4319', origin: 'http://localhost:5179', 'sec-fetch-site': 'same-site', 'sec-fetch-dest': 'empty' },
      LOOPBACK,
    ),
    true,
  )
})

test('a typed URL, a bookmark, or a link opened from a terminal is allowed', () => {
  // Sec-Fetch-Site: none is the browser saying no page caused this request.
  assert.equal(
    sameOrigin(
      { host: '127.0.0.1:4319', 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
      LOOPBACK,
    ),
    true,
  )
})

test('a cross-site top-level navigation is allowed, but only as a navigation', () => {
  // A link on another site pointing at your own aivis. It is not silent — the tab leaves
  // the attacker's page — so refusing it would cost more than it buys.
  assert.equal(
    sameOrigin(
      {
        host: '127.0.0.1:4319',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
      LOOPBACK,
    ),
    true,
  )
  // A cross-site form submission is a navigation to a document as well, but a browser
  // sends its Origin with one, and that is refused as it always was.
  assert.equal(
    sameOrigin(
      {
        host: '127.0.0.1:4319',
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
      LOOPBACK,
    ),
    false,
  )
})

test('a Sec-Fetch-Site this does not recognise is refused rather than skipped', () => {
  // Node joins repeated headers with a comma, and a client chooses what it repeats. A
  // value that is not one exact token cannot be read as permission.
  assert.equal(sameOrigin({ host: '127.0.0.1:4319', 'sec-fetch-site': 'cross-site, none' }, LOOPBACK), false)
  assert.equal(
    sameOrigin({ host: '127.0.0.1:4319', 'sec-fetch-site': ['none', 'cross-site'] as unknown as string }, LOOPBACK),
    false,
  )
  assert.equal(sameOrigin({ host: '127.0.0.1:4319', 'sec-fetch-site': 'Same-Origin' }, LOOPBACK), false)
})
