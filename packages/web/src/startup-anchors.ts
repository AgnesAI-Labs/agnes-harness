import { factChainLinks, workbenchNavigation } from '@agnes/web-client'
import { OWNER_INPUT_PANEL, type OwnerInputCall, registerOwnerInputPanel } from './owner-input-panel.js'

const FACT_CANDIDATE = /^candidate-[a-f0-9]{32}$/
/** Admission keys are 1–256 characters; anything longer cannot name an input. */
const OWNER_INPUT_KEY_LIMIT = 256
let ownerInputPanel: (() => void) | undefined

/**
 * Open what a startup link points at inside the session it opened: `&factCandidate=` focuses that
 * candidate's fact chain, `&ownerInput=` opens the owner input review panel. `sessionId` is the
 * session the link named once it is the one showing; without it nothing opens. `call` is the page's
 * own connection, the only caller allowed the owner-only methods.
 */
export function openStartupAnchors(
  request: URLSearchParams,
  sessionId: string | undefined,
  call: OwnerInputCall,
): void {
  if (!sessionId) return
  const candidateId = request.get('factCandidate')
  if (candidateId && FACT_CANDIDATE.test(candidateId))
    requestAnimationFrame(() =>
      factChainLinks.open({ sessionId, laneId: 'main', anchor: { kind: 'authoring', candidateId } }),
    )
  const key = request.get('ownerInput')
  if (!key || key.length > OWNER_INPUT_KEY_LIMIT) return
  ownerInputPanel?.()
  ownerInputPanel = registerOwnerInputPanel({ sessionId, key }, call)
  // The dock picks the panel up on its next render; the tab stays in the dock if this open is early.
  requestAnimationFrame(() => workbenchNavigation.open(OWNER_INPUT_PANEL))
}
