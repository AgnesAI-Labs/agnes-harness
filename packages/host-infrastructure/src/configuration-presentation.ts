import {
  type ApplicationConfigSnapshot,
  ApplicationSelection,
  PresentationRoleSelections,
  validateAgainst,
} from '@agnes/protocol'
import { ConfigurationError } from './configuration-error.js'

type PresentationConfiguration = {
  revision: number
  executionRevision?: number
  application?: ApplicationSelection
  roleSelections?: PresentationRoleSelections
}
export function presentationSnapshot(
  current: PresentationConfiguration | undefined,
): ApplicationConfigSnapshot {
  return {
    revision: current?.revision ?? 0,
    selection: structuredClone(current?.application ?? null),
    ...(current?.roleSelections ? { roleSelections: structuredClone(current.roleSelections) } : {}),
  }
}
/** Called inside the configuration writer lock. Presentation never increments executionRevision. */
export function updatePresentation<State extends PresentationConfiguration>(
  input: ApplicationConfigSnapshot,
  current: State | undefined,
  initial: State,
): State {
  if (
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    (input.roleSelections !== undefined &&
      !validateAgainst(PresentationRoleSelections, input.roleSelections).ok) ||
    (input.selection !== null && !validateAgainst(ApplicationSelection, input.selection).ok)
  )
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  if (input.revision !== (current?.revision ?? 0)) throw new ConfigurationError('CONFIG_REVISION_CONFLICT')
  const next = {
    ...initial,
    ...current,
    revision: input.revision + 1,
    executionRevision: current?.executionRevision ?? current?.revision ?? 0,
  }
  if (input.selection === null) delete next.application
  else next.application = structuredClone(input.selection)
  if (input.roleSelections !== undefined) {
    if (Object.keys(input.roleSelections).length) next.roleSelections = structuredClone(input.roleSelections)
    else delete next.roleSelections
  }
  return next
}
