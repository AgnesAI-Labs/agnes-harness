import { RegionErrorBoundary, SettingsState } from '@agnes/web-ui'
import type { TerminalScreenProps } from '@agnes/web-ui/terminal'
import { lazy, Suspense, useState } from 'react'

type TerminalLoader = () => Promise<typeof import('@agnes/web-ui/terminal')>
// Every terminal tab mounts its own lazy screen, and switching tabs mounts two at once, so they share
// one import. A browser caches the module either way; Vitest 5 can hand a caller of a concurrent
// dynamic import the real module in place of a vi.mock, which made the panel tests render xterm.
// A failed load is dropped, so the boundary's retry starts a fresh import.
let terminalModule: ReturnType<TerminalLoader> | undefined
const loadTerminal: TerminalLoader = () => {
  terminalModule ??= import('@agnes/web-ui/terminal').catch((error: unknown) => {
    terminalModule = undefined
    throw error
  })
  return terminalModule
}

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
