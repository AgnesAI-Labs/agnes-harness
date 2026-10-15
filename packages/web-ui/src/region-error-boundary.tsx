import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useDocumentLanguage } from './document-language.js'
import { fallbackT } from './locales/index.js'
import { Button } from './ui/button.js'

/** Outer region isolation supplements, rather than replaces, SlotOutlet's plugin boundaries. */
export class RegionErrorBoundary extends Component<
  { region: string; children: ReactNode; owner?: Document; message?: string },
  { failed: boolean; attempt: number }
> {
  override state = { failed: false, attempt: 0 }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    // The Web host's console capture redacts and includes this diagnostic in exported bundles.
    console.error('Agnes region render failed', this.props.region, error, info.componentStack)
  }
  override render() {
    if (this.state.failed)
      return (
        <RegionFailure
          region={this.props.region}
          message={this.props.message}
          owner={this.props.owner}
          retry={() => this.setState(({ attempt }) => ({ failed: false, attempt: attempt + 1 }))}
        />
      )
    return <RegionAttempt key={this.state.attempt}>{this.props.children}</RegionAttempt>
  }
}
function RegionAttempt({ children }: { children: ReactNode }) {
  return <>{children}</>
}

function RegionFailure({
  region,
  retry,
  owner,
  message,
}: {
  region: string
  retry(): void
  owner: Document | undefined
  message: string | undefined
}) {
  useDocumentLanguage(owner)
  return (
    <div role="alert" data-agnes-region-error={region}>
      {message ?? fallbackT('ui.regionError')}
      {' · '}
      <Button onClick={retry}>{fallbackT('ui.retry')}</Button>
    </div>
  )
}
