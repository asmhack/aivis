import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { BuildNotice } from './components/BuildNotice.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('missing #root')
createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      {/*
        Outside `App` and inside the boundary: a page that disagrees with its server can
        crash anywhere, so the notice belongs to neither route, and if the crash comes
        first the boundary replaces it with a panel that says the same thing.
      */}
      <BuildNotice />
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
