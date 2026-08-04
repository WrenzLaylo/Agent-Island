interface OnboardingCardProps {
  onComplete: () => void
}

export function OnboardingCard({ onComplete }: OnboardingCardProps) {
  return (
    <div className="onboarding-view">
      <div className="onboarding-symbol" aria-hidden="true"><span /><span /><span /></div>
      <div className="onboarding-copy">
        <strong>Meet Agent Island</strong>
        <p>A quiet control surface for Claude, Codex and Hermes.</p>
      </div>
      <div className="onboarding-steps">
        <span><b>1</b><small>Drag the island anywhere on your screen.</small></span>
        <span><b>2</b><small>Drop it near an edge to dock it as a circle.</small></span>
        <span><b>3</b><small>Drop near the top centre, or press Ctrl/⌘ + Alt + Home, to reset it.</small></span>
        <span><b>4</b><small>It stays pitch black while idle and wakes only for activity.</small></span>
      </div>
      <button type="button" className="primary-button onboarding-button" data-no-drag="true" onClick={onComplete}>
        Got it
      </button>
    </div>
  )
}
