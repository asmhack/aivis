import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { BuildStatus } from '../shared/types.ts'

/**
 * A fingerprint of the built front end, or null when there is none to read.
 *
 * Vite names the script and stylesheet it emits by content hash and writes those names
 * into `dist/index.html`, so that one small file changes whenever any part of the front end
 * is rebuilt into something different. Hashing it is therefore a stand-in for hashing the
 * whole build, at the cost of reading about a kilobyte.
 */
export async function clientBuildId(distDir: string): Promise<string | null> {
  try {
    const html = await fs.readFile(path.join(distDir, 'index.html'))
    return createHash('sha256').update(html).digest('hex').slice(0, 16)
  } catch {
    // There is no build here to speak for. `npm run dev`, where Vite serves the front end
    // and this server only answers the API, is the ordinary way to be in that state.
    return null
  }
}

/**
 * Whether the page asking this is one the server can still be trusted to answer.
 *
 * `dist` is read off disk on every request rather than held in memory, so `npm run build`
 * replaces the front end under a server that goes on running the code it started with. The
 * browser then loads a page newer than the process serving it, and the first field the new
 * client reads that the old server does not send throws during render — which is how this
 * is met in practice: a TypeError about a property of undefined, on a page that had been
 * working, with nothing on screen to connect it to the rebuild that caused it.
 *
 * Comparing the build on disk against the one this process started with is what turns that
 * into something the page can state. A server serving no front end at all has nothing to
 * disagree with, so it reports `serving: false` and the page says nothing.
 */
export function compareBuild(
  serving: boolean,
  booted: string | null,
  current: string | null,
): BuildStatus {
  if (!serving) return { serving: false, stale: false }
  // A build that appeared after start-up counts too: the process booted with no `dist` and
  // is now handing out a front end it has never agreed with.
  return { serving: true, stale: current !== null && current !== booted }
}
