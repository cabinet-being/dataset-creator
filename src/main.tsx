import React from 'react'
import ReactDOM from 'react-dom/client'
import NextApp from './next/NextApp'
import { cleanupLegacyStorage } from './lib/legacyStorageCleanup'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import './index.css'
import { CommandProvider } from './components/workspace/Commands'
import { requestPersistentStorage } from './services/video/videoCache'

cleanupLegacyStorage();

// Keeps downloaded models from being evicted; harmless when the API is missing.
void requestPersistentStorage()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary><CommandProvider><NextApp /></CommandProvider></AppErrorBoundary>
  </React.StrictMode>,
)
