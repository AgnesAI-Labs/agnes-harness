import { PINNED_SEAM_KINDS } from '@agnes/extension-api/seams'
import type { SeamBinding } from '@agnes/host-providers/assemble/seam-rows'
import type { PinnedSeam, SessionGenerationPin } from '@agnes/package-manager'

/** A built generation container, with the implementation each seam kind was bound to. */
export type ContainerHandle = Readonly<{
  generationId: string
  seams: readonly SeamBinding[]
  close(): Promise<void>
}>

/** What a session is bound to: its generation, loop and the seam implementations it keeps. */
export type SessionBinding = Readonly<{
  sessionKey: string
  generationId: string
  loop?: Readonly<{ id: string; version: string }>
  pinnedSeams: readonly PinnedSeam[]
}>

export function sessionBindingOf(pin: SessionGenerationPin | undefined): SessionBinding | undefined {
  return pin
    ? {
        sessionKey: pin.sessionKey,
        generationId: pin.generationId,
        ...(pin.loop ? { loop: pin.loop } : {}),
        pinnedSeams: pin.seams ?? [],
      }
    : undefined
}

/** When a changed seam implementation reaches sessions. */
export type SeamChangeEffect = 'applied' | 'new-sessions' | 'restart-required'

/** The outcome of one publish, including a failure and whether the previous state was restored. */
export type ChangeResult = Readonly<{
  outcome: 'unchanged' | 'in-place' | 'forked' | 'rejected'
  generationId: string
  seamChanges: readonly Readonly<{
    kind: string
    from?: SeamBinding
    to?: SeamBinding
    effect: SeamChangeEffect
  }>[]
  /** Inputs that changed and need a restart before they take effect. */
  restartRequired: readonly string[]
  failures: readonly Readonly<{ stage: string; code: string; message: string; reason?: string }>[]
  /** True when a failed publish left the previous generation exactly as it was. */
  recovered: boolean
}>

const PINNED = new Set<string>(PINNED_SEAM_KINDS)

const sameBinding = (a: SeamBinding, b: SeamBinding): boolean =>
  a.provider === b.provider &&
  a.version === b.version &&
  a.sourcePackage === b.sourcePackage &&
  a.integrity === b.integrity

/**
 * Per-kind seam changes between the container new sessions open on and the container a publish
 * produced. A pinned kind reaches new sessions only (bound sessions keep theirs); an unpinned kind
 * follows whichever container serves the session, so it is applied where the publish landed in place.
 */
export function seamChangesBetween(
  before: readonly SeamBinding[],
  after: readonly SeamBinding[],
  placement: 'in-place' | 'forked',
): ChangeResult['seamChanges'] {
  const kinds = [...new Set([...before, ...after].map((binding) => binding.kind))].sort()
  return kinds.flatMap((kind) => {
    const from = before.find((binding) => binding.kind === kind)
    const to = after.find((binding) => binding.kind === kind)
    if (from && to && sameBinding(from, to)) return []
    return [
      {
        kind,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        effect: (placement === 'forked' || PINNED.has(kind) ? 'new-sessions' : 'applied') as SeamChangeEffect,
      },
    ]
  })
}

export function changeResult(
  input: Readonly<{
    outcome: ChangeResult['outcome']
    generationId: string
    before?: readonly SeamBinding[]
    after?: readonly SeamBinding[]
    restartRequired?: readonly string[]
    failures?: ChangeResult['failures']
    recovered?: boolean
  }>,
): ChangeResult {
  const placement = input.outcome === 'forked' ? 'forked' : 'in-place'
  return Object.freeze({
    outcome: input.outcome,
    generationId: input.generationId,
    seamChanges: Object.freeze(
      input.before && input.after ? seamChangesBetween(input.before, input.after, placement) : [],
    ),
    restartRequired: Object.freeze([...(input.restartRequired ?? [])]),
    failures: Object.freeze([...(input.failures ?? [])]),
    recovered: input.recovered ?? input.outcome !== 'rejected',
  })
}
