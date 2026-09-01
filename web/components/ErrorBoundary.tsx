import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useBuild } from '../useBuild.ts'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * What to make of the crash, once the server has been asked.
 *
 * A version mismatch is the likeliest cause of a crash here and reads as an unrelated
 * TypeError, so the panel used to offer it as a guess on every error alike. The server can
 * be asked outright, and the answer is worth waiting the one round trip for: told which of
 * the two is behind, the reader stops reading a stack trace and restarts the server.
 */
function CrashHint(): React.JSX.Element {
  const build = useBuild()
  if (build === 'stale') {
    return (
      <p className="crash__hint">
        This server has been running since before the front end was last built, so it is
        answering a page newer than itself and the two disagree about the shape of a session.
        That is what threw. Restart it with <code>npm restart</code>.
      </p>
    )
  }
  return (
    <p className="crash__hint">
      If the server has been running since before the last front-end build, restart it — the two
      have to agree on the shape of a session.
    </p>
  )
}

/**
 * Catch a render crash and show it, instead of unmounting the tree to a blank page.
 *
 * The client and the server are versioned together but restarted separately, so a
 * server left running across a front-end rebuild can send sessions that are missing a
 * field the new client reads. That used to throw during render and leave nothing on
 * screen at all, which says none of what went wrong; showing the error and offering a
 * reload at least names the problem, and `CrashHint` above asks the server whether that
 * mismatch is in fact what happened rather than leaving the reader to wonder.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('aivis: render failed', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="page page--message">
        <h1 className="crash__title">aivis hit a rendering error</h1>
        <CrashHint />
        <pre className="crash__detail">{error.message}</pre>
        <button className="crash__retry" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}
