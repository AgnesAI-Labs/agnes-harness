import { createHash } from 'node:crypto'
import type { ProviderLifecycleScope, ProviderSelection } from '@agnes/extension-api'
import type { SeamKind } from '@agnes/extension-api/seams'
import { PINNED_SEAM_KINDS, SEAM_KIND_TOKENS, SEAM_KINDS } from '@agnes/extension-api/seams'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'

/** Where a conclusion in the plan came from. */
export type RunPlanSource = 'template' | 'user' | 'managed' | 'generation' | 'default'

export type SeamSelectionPlan = Readonly<{
  kind: SeamKind
  selection: ProviderSelection
  required: boolean
  pinned: boolean
  scope: ProviderLifecycleScope
}>

/** The selections a generation snapshot recorded; they replace the profile's when a container is rebuilt. */
export type SnapshotSeams = Readonly<{
  formatVersion: 1
  selections: Readonly<Record<string, ProviderSelection>>
}>

export type RunPlan = Readonly<{
  profileHash: string
  /** The seven seam selections, in kind order. */
  seams: readonly SeamSelectionPlan[]
  /** Inputs that need a restart when they change; the digest is what generations are compared by. */
  processFacets: Readonly<{ digest: string; parts: Readonly<Record<string, unknown>> }>
  /** Which layer decided each conclusion, for the runtime descriptor and for troubleshooting. */
  explain: readonly Readonly<{ key: string; value: unknown; source: RunPlanSource }>[]
}>

/**
 * Configuration compilation: a pure function of the profile (and, for a rebuilt container, the
 * generation snapshot). It does no I/O and creates no instance, so every selection error is
 * reported before anything starts. The Host passes its result to instance management as the only
 * description of what to build.
 */
export function compileRunPlan(
  input: Readonly<{
    profile: ResolvedProfile
    agnesVersion?: string
    snapshotSeams?: SnapshotSeams
    /** The selections the built-in template made, to tell a template default from a user choice. */
    templateSeams?: Readonly<Partial<Record<SeamKind, ProviderSelection>>>
  }>,
): RunPlan {
  const { profile } = input
  const explain: { key: string; value: unknown; source: RunPlanSource }[] = []
  const seams = SEAM_KINDS.map((kind): SeamSelectionPlan => {
    const recorded = input.snapshotSeams?.selections[kind]
    const selection = recorded ?? profile.seams[kind]
    const template = input.templateSeams?.[kind]
    const source: RunPlanSource = recorded
      ? 'generation'
      : template && sameSelection(template, selection)
        ? 'template'
        : layerOf(profile)
    explain.push({ key: `providers.${kind}`, value: selection, source })
    return Object.freeze({
      kind,
      selection: Object.freeze({ ...selection }),
      required: true,
      pinned: (PINNED_SEAM_KINDS as readonly string[]).includes(kind),
      scope: SEAM_KIND_TOKENS[kind].scope,
    })
  })
  const { secrets: _secrets, ...fixedAdapters } = profile.adapters
  // Mutable model routes and credential stores follow applyModelProfile; deployment identity still
  // pins backend and plugin registries, including their loop/adapter selections.
  const parts = {
    adapters: fixedAdapters,
    persistence: profile.persistence,
    sandboxProvider: profile.sandbox,
    composition: profile.composition,
    bundlePresets: profile.bundlePresets,
    agnesVersion: input.agnesVersion,
    builtinPackages: profile.packages
      .filter((pkg) => pkg.trust === 'builtin')
      .map(({ id, version, integrity }) => ({ id, version, integrity })),
  }
  return Object.freeze({
    profileHash: profile.hash,
    seams: Object.freeze(seams),
    processFacets: Object.freeze({
      digest: createHash('sha256').update(JSON.stringify(parts)).digest('hex'),
      parts: Object.freeze(parts),
    }),
    explain: Object.freeze(explain.map((entry) => Object.freeze(entry))),
  })
}

/** The selection record a new generation snapshot stores. */
export function seamSelectionsOf(plan: RunPlan): SnapshotSeams {
  return {
    formatVersion: 1,
    selections: Object.fromEntries(plan.seams.map((seam) => [seam.kind, seam.selection])),
  }
}

const sameSelection = (a: ProviderSelection, b: ProviderSelection): boolean =>
  a.provider === b.provider && a.version === b.version

/** The last configuration layer that is not the built-in template. */
function layerOf(profile: ResolvedProfile): RunPlanSource {
  for (const entry of [...profile.chain].reverse()) {
    if (entry.startsWith('managed:')) return 'managed'
    if (entry.startsWith('user:') || entry.startsWith('local:')) return 'user'
  }
  return 'template'
}
