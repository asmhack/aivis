import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Catch a render crash and show it, instead of unmounting the tree to a blank page.
 *
 * The client and the server are versioned together but restarted separately, so a
 * server left running across a front-end rebuild can send sessions that are missing a
 * field the new client reads. That used to throw during render and leave nothing on
 * screen at all, which says none of what went wrong; showing the error and offering a
 * reload at least names the problem.
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
        <p className="crash__hint">
          If the server has been running since before the last front-end build, restart it — the two
          have to agree on the shape of a session.
        </p>
        <pre className="crash__detail">{error.message}</pre>
        <button className="crash__retry" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}
