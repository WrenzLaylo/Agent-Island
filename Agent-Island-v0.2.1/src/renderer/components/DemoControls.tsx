import type { AgentId } from '@shared/contracts'

interface DemoControlsProps {
  agents: AgentId[]
  onSimulateApproval: (agentId: AgentId) => void
  onThinking: () => void
  onRunning: () => void
  onComplete: () => void
  onError: () => void
}

export function DemoControls(props: DemoControlsProps) {
  return (
    <div className="demo-controls" aria-label="Demo controls">
      <span className="demo-label">Demo</span>
      <button type="button" onClick={props.onThinking}>
        Thinking
      </button>
      <button type="button" onClick={props.onRunning}>
        Running
      </button>
      <button type="button" onClick={props.onComplete}>
        Complete
      </button>
      <button type="button" onClick={props.onError}>
        Error
      </button>
      {props.agents.map((agentId) => (
        <button key={agentId} type="button" onClick={() => props.onSimulateApproval(agentId)}>
          Approve · {agentId}
        </button>
      ))}
    </div>
  )
}
