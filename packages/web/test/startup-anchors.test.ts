/** @vitest-environment happy-dom */

import type { FactChainParams } from '@agnes/protocol'
import {
  factChainLinks,
  type UiExtensionContext,
  workbenchNavigation,
  workbenchPanels,
} from '@agnes/web-client'
import { afterEach, expect, it, vi } from 'vitest'
import { OWNER_INPUT_PANEL } from '../src/owner-input-panel.js'
import { openStartupAnchors } from '../src/startup-anchors.js'

const candidateId = `candidate-${'a'.repeat(32)}`
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
const contextFor = (sessionId: string) =>
  ({ t: (key: string) => key, data: { session: { id: sessionId } } }) as unknown as UiExtensionContext

const hostCall = async <T>(): Promise<T> => ({}) as T
const stops: Array<() => void> = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

function links() {
  const facts: FactChainParams[] = []
  const panels: string[] = []
  stops.push(
    factChainLinks.register((target) => {
      facts.push(target)
      return true
    }),
    workbenchNavigation.register((id) => {
      panels.push(id)
      return true
    }),
  )
  return { facts, panels }
}

it('an ownerInput param longer than 256 characters is ignored; factCandidate opens as before', async () => {
  const { facts, panels } = links()
  openStartupAnchors(
    new URLSearchParams({ factCandidate: candidateId, ownerInput: 'k'.repeat(257) }),
    's1',
    hostCall,
  )
  await nextFrame()
  await nextFrame()
  expect(facts).toEqual([{ sessionId: 's1', laneId: 'main', anchor: { kind: 'authoring', candidateId } }])
  expect(panels).toEqual([])
  expect(workbenchPanels.get(OWNER_INPUT_PANEL)).toBeUndefined()

  // A malformed candidate, or a link whose session did not open, opens nothing.
  openStartupAnchors(new URLSearchParams({ factCandidate: 'candidate-xyz' }), 's1', hostCall)
  openStartupAnchors(
    new URLSearchParams({ factCandidate: candidateId, ownerInput: 'k1' }),
    undefined,
    hostCall,
  )
  await nextFrame()
  expect(facts).toHaveLength(1)
  expect(panels).toEqual([])

  // A key of 256 characters opens the owner input panel, shown only beside its own session.
  const key = 'k'.repeat(256)
  openStartupAnchors(new URLSearchParams({ ownerInput: key }), 's1', hostCall)
  await vi.waitFor(() => expect(panels).toEqual([OWNER_INPUT_PANEL]))
  const panel = workbenchPanels.get(OWNER_INPUT_PANEL)
  expect(panel).toMatchObject({ edge: 'right', visibility: 'contextual' })
  expect(panel?.when?.(contextFor('s1'))).toBe(true)
  expect(panel?.when?.(contextFor('s2'))).toBe(false)
  expect(facts).toHaveLength(1)
})
