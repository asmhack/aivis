import { useState } from 'react'
import { useBuild } from '../useBuild.ts'

/**
 * Says so when the server answering this page is older than the page itself.
 *
 * `npm run build` replaces the front end on disk, and a server that keeps running goes on
 * serving the new page while answering it from the code it started with. The two then
 * disagree about the shape of a session, and the first field the page reads that the
 * server does not send throws mid-render — leaving a crash panel naming a property of
 * undefined and nothing at all to connect it to the rebuild. This is the connection, said
 * before anything throws and while the page is still working.
 *
 * It floats over the app rather than sitting above it because both the fleet index and the
 * session page are laid out to fill the viewport exactly, so anything in the flow above
 * them pushes their last row out of sight. It can be dismissed for the same reason: the
 * app underneath is usually still usable, and a reader who has taken the point should not
 * have to read it again to reach what is behind it.
 */
export function BuildNotice(): React.JSX.Element | null {
  const build = useBuild()
  const [dismissed, setDismissed] = useState(false)
  if (build !== 'stale' || dismissed) return null
  return (
    <div className="skew" role="status">
      <span>
        The front end has been rebuilt since this server started, so this page and the server
        answering it are two different versions of aivis. Restart it with{' '}
        <code>npm restart</code> so that both come from one build.
      </span>
      <button className="skew__close" onClick={() => setDismissed(true)} aria-label="Dismiss">
        ×
      </button>
    </div>
  )
}
