import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { CommandProvider } from './components/workspace/Commands'
import { InspectorProvider } from './components/workspace/InspectorHost'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CommandProvider><InspectorProvider><App /></InspectorProvider></CommandProvider>
  </React.StrictMode>,
)
