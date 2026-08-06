import { useEffect, useState } from 'react'
import type { IslandSettings, PreferredDockSide } from '@shared/contracts'
import { CloseIcon } from './icons'

interface SettingsPanelProps {
  settings: IslandSettings
  onChange: (patch: Partial<IslandSettings>) => void
  onClose: () => void
  onReturnHome: () => void
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      className={`toggle ${checked ? 'is-on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-no-drag="true"
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}

export function SettingsPanel({ settings, onChange, onClose, onReturnHome }: SettingsPanelProps) {
  const setDock = (value: string) => onChange({ preferredDockSide: value as PreferredDockSide })
  const [shimBusy, setShimBusy] = useState(false)
  const [shimNote, setShimNote] = useState('')

  useEffect(() => {
    void window.agentIsland.shimStatus().then((status) => {
      if (!status.wrapperExists) setShimNote('Wrapper missing — rebuild Agent Island.')
    })
  }, [])

  const toggleShims = async () => {
    setShimBusy(true)
    const result = settings.shellShimsInstalled
      ? await window.agentIsland.uninstallShims()
      : await window.agentIsland.installShims()
    setShimBusy(false)
    if (result.ok) {
      onChange({ shellShimsInstalled: !settings.shellShimsInstalled })
      setShimNote(
        settings.shellShimsInstalled
          ? 'Removed. Open a new terminal for it to take effect.'
          : 'Installed. Open a new terminal for it to take effect.'
      )
    } else {
      setShimNote(result.errors[0] ?? 'Could not update the shell profiles.')
    }
  }

  return (
    <div className="settings-view">
      <div className="panel-header" data-drag-region="true">
        <div>
          <strong>Agent Island settings</strong>
          <small>Keep the island quiet, useful and out of the way.</small>
        </div>
        <button type="button" className="icon-button" data-no-drag="true" onClick={onClose} aria-label="Close settings">
          <CloseIcon />
        </button>
      </div>

      <div className="settings-scroll">
        <section className="settings-group">
          <h3>Behaviour</h3>
          <label className="setting-row">
            <span><strong>Auto-expand approvals</strong><small>Open immediately when an agent needs a decision.</small></span>
            <Toggle checked={settings.autoExpandApprovals} onChange={(value) => onChange({ autoExpandApprovals: value })} label="Auto-expand approvals" />
          </label>
          <label className="setting-row">
            <span><strong>Always on top</strong><small>Keep the island above other windows.</small></span>
            <Toggle checked={settings.alwaysOnTop} onChange={(value) => onChange({ alwaysOnTop: value })} label="Always on top" />
          </label>
          <label className="setting-row">
            <span><strong>Launch at startup</strong><small>Start Agent Island when you sign in.</small></span>
            <Toggle checked={settings.launchAtStartup} onChange={(value) => onChange({ launchAtStartup: value })} label="Launch at startup" />
          </label>
          <label className="setting-row">
            <span><strong>Approval sound</strong><small>Play a quiet cue when attention is required.</small></span>
            <Toggle checked={settings.approvalSounds} onChange={(value) => onChange({ approvalSounds: value })} label="Approval sound" />
          </label>
          <label className="setting-row">
            <span><strong>Remember active agent</strong><small>Restore your last selected agent on launch.</small></span>
            <Toggle checked={settings.rememberLastAgent} onChange={(value) => onChange({ rememberLastAgent: value })} label="Remember active agent" />
          </label>
          <div className="setting-action">
            <span><strong>Return to original position</strong><small>Move the island to the top centre of this display. Shortcut: Ctrl/⌘ + Alt + Home.</small></span>
            <button type="button" className="setting-action-button" data-no-drag="true" onClick={onReturnHome}>Return home</button>
          </div>
        </section>

        <section className="settings-group">
          <h3>Display</h3>
          <label className="setting-slider">
            <span><strong>Auto-collapse delay</strong><small>{(settings.autoCollapseMs / 1000).toFixed(1)} seconds</small></span>
            <input
              type="range"
              min="500"
              max="3000"
              step="100"
              value={settings.autoCollapseMs}
              data-no-drag="true"
              onChange={(event: { target: { value: string } }) => onChange({ autoCollapseMs: Number(event.target.value) })}
            />
          </label>
          <label className="setting-row">
            <span><strong>Quiet idle pill</strong><small>Show a plain pitch-black pill with no text while nothing is happening.</small></span>
            <Toggle checked={settings.quietIdle} onChange={(value) => onChange({ quietIdle: value })} label="Quiet idle pill" />
          </label>
          <label className="setting-row">
            <span><strong>Reduced motion</strong><small>Use shorter fades instead of spring movement.</small></span>
            <Toggle checked={settings.reducedMotion} onChange={(value) => onChange({ reducedMotion: value })} label="Reduced motion" />
          </label>
          <label className="setting-select">
            <span><strong>Preferred dock side</strong><small>Used when no position is saved for a display.</small></span>
            <select value={settings.preferredDockSide} data-no-drag="true" onChange={(event: { target: { value: string } }) => setDock(event.target.value)}>
              <option value="none">No preference</option>
              <option value="left">Left</option>
              <option value="right">Right</option>
            </select>
          </label>
        </section>

        <section className="settings-group">
          <h3>Terminals</h3>
          <label className="setting-row">
            <span>
              <strong>Bring the terminal to this display</strong>
              <small>On &ldquo;Continue in Terminal&rdquo;, move the agent&rsquo;s window to the display Agent Island is on. Turn off to focus it where it already is.</small>
            </span>
            <Toggle
              checked={settings.moveTerminalToIsland}
              onChange={(value) => onChange({ moveTerminalToIsland: value })}
              label="Bring the terminal to this display"
            />
          </label>
          <div className="setting-action">
            <span>
              <strong>Shell integration</strong>
              <small>
                {settings.shellShimsInstalled
                  ? 'claude, codex and hermes run through Agent Island so their sessions are visible.'
                  : 'Without this, run "island claude" to make a session visible. Shims fall back to the real command if anything goes wrong.'}
                {shimNote ? ` ${shimNote}` : ''}
              </small>
            </span>
            <button
              type="button"
              className="setting-action-button"
              data-no-drag="true"
              disabled={shimBusy}
              onClick={() => void toggleShims()}
            >
              {settings.shellShimsInstalled ? 'Remove' : 'Install'}
            </button>
          </div>
        </section>

        <section className="settings-group">
          <h3>Advanced</h3>
          <label className="setting-row">
            <span><strong>Developer diagnostics</strong><small>Show integration details and version information.</small></span>
            <Toggle checked={settings.developerDiagnostics} onChange={(value) => onChange({ developerDiagnostics: value })} label="Developer diagnostics" />
          </label>
        </section>
      </div>

      <p className="settings-footnote">Position and core behaviour are also available from the system tray.</p>
    </div>
  )
}
