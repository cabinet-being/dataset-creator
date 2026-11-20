import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { CommandProvider } from './components/workspace/Commands'
import { InspectorProvider } from './components/workspace/InspectorHost'
import { requestPersistentStorage } from './services/video/videoCache'

// Keeps downloaded models from being evicted; harmless when the API is missing.
void requestPersistentStorage()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CommandProvider><InspectorProvider><App /></InspectorProvider></CommandProvider>
  </React.StrictMode>,
)
