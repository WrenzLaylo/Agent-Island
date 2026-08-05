import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TerminalWindow } from './TerminalWindow'
import './styles/terminal.css'

createRoot(document.getElementById('terminal-root')!).render(
  <StrictMode>
    <TerminalWindow />
  </StrictMode>
)
