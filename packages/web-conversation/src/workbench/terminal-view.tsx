import { RegionErrorBoundary, SettingsState } from '@agnes/web-ui'
import type { TerminalScreenProps } from '@agnes/web-ui/terminal'
import { lazy, Suspense, useState } from 'react'

type TerminalLoader = () => Promise<typeof import('@agnes/web-ui/terminal')>
const loadTerminal: TerminalLoader = () => import('@agnes/web-ui/terminal')

export function TerminalView({
  failure,
  loading,
  load = loadTerminal,
  ...props
}: TerminalScreenProps & { failure: string; loading: string; load?: TerminalLoader }) {
  return (
    <RegionErrorBoundary region="terminal" message={failure}>
      <ScreenAttempt load={load} loading={loading} {...props} />
    </RegionErrorBoundary>
  )
}

function ScreenAttempt({
  load,
  loading,
  ...props
}: TerminalScreenProps & { load: TerminalLoader; loading: string }) {
  // A retry remounts this attempt: React.lazy caches rejection on the component type.
  const [Screen] = useState(() => lazy(() => load().then((module) => ({ default: module.TerminalScreen }))))
  return (
    <Suspense fallback={<SettingsState tone="loading">{loading}</SettingsState>}>
      <Screen {...props} />
    </Suspense>
  )
}
