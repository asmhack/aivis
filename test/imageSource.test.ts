/**
 * Tests for the rule that decides whether a markdown image is fetched.
 *
 * This is the one piece of the front end where being wrong is silent and expensive: a
 * source misread as a local path is wrapped in a same-origin URL and fails visibly, but a
 * source misread as local when it names another host becomes an `<img>` the browser fetches
 * with no click, which is exactly the zero-click exfiltration beacon a prompt-injected model
 * would write into a reply. Nothing on screen would say it happened. So every shape that has
 * ever been used to smuggle a remote address past a naive check is pinned here.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyImageSource } from '../web/imageSource.ts'

/** Shorthand: only the classification matters in most cases. */
const kind = (src: string): string => classifyImageSource(src).kind

test('an address on another host is never fetched, however it is written', () => {
  assert.equal(kind('https://a/x.png'), 'elsewhere')
  assert.equal(kind('http://a/x.png'), 'elsewhere')
  // Schemes are case-insensitive to a browser, so the check has to be too.
  assert.equal(kind('HTTPS://a/x.png'), 'elsewhere')
  assert.equal(kind('HtTpS://a/x.png'), 'elsewhere')
  // Markdown keeps surrounding space; a browser does not.
  assert.equal(kind('  https://a/x.png '), 'elsewhere')
  assert.equal(kind('\thttps://a/x.png\n'), 'elsewhere')
  // Protocol-relative: no scheme at all, and still another origin.
  assert.equal(kind('//a/x.png'), 'elsewhere')
  // Not an image and not followable, but just as much someone else's address.
  assert.equal(kind('mailto:a@b'), 'elsewhere')
  assert.equal(kind('file:///etc/passwd'), 'elsewhere')
  assert.equal(kind('javascript:alert(1)'), 'elsewhere')
  assert.equal(kind('blob:https://a/1234'), 'elsewhere')
  // A data: URL that is not an image is not the harmless case either.
  assert.equal(kind('data:text/html,<script>0</script>'), 'elsewhere')
})

test('only a web address is offered as a link, and the rest is left as text', () => {
  assert.equal(classifyImageSource('https://a/x.png').followable, true)
  assert.equal(classifyImageSource('HTTP://a/x.png').followable, true)
  assert.equal(classifyImageSource('mailto:a@b').followable, false)
  assert.equal(classifyImageSource('javascript:alert(1)').followable, false)
  assert.equal(classifyImageSource('//a/x.png').followable, false)
})

test('the target is what a browser would resolve, so the link and the text match it', () => {
  assert.equal(classifyImageSource('  https://a/x.png ').target, 'https://a/x.png')
  assert.equal(classifyImageSource('docs/x.png').target, 'docs/x.png')
})

test('what aivis already serves is loaded as it stands', () => {
  assert.equal(kind('/api/sessions/x/image?uuid=1&index=0'), 'served')
  assert.equal(kind('data:image/png;base64,AAAA'), 'served')
  assert.equal(kind('DATA:IMAGE/PNG;base64,AAAA'), 'served')
})

test('anything the classifier cannot place stays a path, which cannot leave the machine', () => {
  assert.equal(kind('/Users/me/shot.png'), 'path')
  assert.equal(kind('docs/x.png'), 'path')
  assert.equal(kind('./x.png'), 'path')
  // A scheme broken across a line is not a scheme to a browser either — but the point is
  // that failing to recognise it is safe, because the fallback is the same-origin path.
  assert.equal(kind('htt\nps://evil/x.png'), 'path')
  // A single letter before the colon is a Windows drive far more often than a scheme, and
  // it is a path either way as far as this decision goes.
  assert.equal(kind('c:/shots/x.png'), 'path')
  assert.equal(kind(''), 'path')
})
