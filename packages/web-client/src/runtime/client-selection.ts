// Resolves the server-chosen client selection of a welcome against the welcome's module catalog. The
// SDK has already checked both against the wire schema; this checks what the schema cannot express:
// every reference names exactly one catalog contribution of the right kind that serves this client's
// target, every selected renderer's declared descriptor describes that very contribution, and no package
// the selection uses mixes two generations. Nothing falls back to a default.
import type {
  ClientModule,
  ClientWelcome,
  Outcome,
  RendererDescriptor,
  RuntimeError,
} from '@agnes/extension-api/client'

export type ClientSelection = NonNullable<ClientWelcome['clientSelection']>
export type ClientModuleContribution = NonNullable<ClientModule['contributions']>[number]
export type ClientTarget = ClientSelection['target']

/** One contribution the server-chosen selection names, located in the catalog module that declares it. */
export interface SelectedContribution {
  readonly moduleId: string
  readonly packageId: string
  readonly packageDigest: string
  readonly entryPath: string
  readonly contributionId: string
}

/** A selected renderer, with the descriptor its catalog contribution declares. */
export interface SelectedRenderer extends SelectedContribution {
  readonly descriptor: RendererDescriptor
}

/** A selected shell or UI registry, with the export of its signed module that implements it. */
export interface SelectedService extends SelectedContribution {
  readonly export: string
}

/**
 * `legacy` is a welcome without a selection: the client keeps its old module path. `selected` names, for
 * this client's target, exactly one catalog module for every contribution the selection uses.
 */
export type ResolvedClientSelection =
  | { readonly kind: 'legacy' }
  | {
      readonly kind: 'selected'
      readonly target: ClientTarget
      readonly shell: SelectedService | null
      readonly registry: SelectedService
      readonly fallbackRenderer: SelectedRenderer
      readonly renderers: ReadonlyArray<{
        readonly renderKey: string
        readonly renderer: SelectedRenderer
      }>
    }

type Ref = ClientSelection['registry']
type Declared = { readonly module: ClientModule; readonly contribution: ClientModuleContribution }

const refuse = (detailCode: string, message: string): { ok: false; error: RuntimeError } => ({
  ok: false,
  error: {
    code: 'incompatible',
    detailCode,
    message,
    retryAdvice: { kind: 'never' },
    diagnosticId: 'web-client-selection',
  },
})

const serves = ({ module, contribution }: Declared, target: ClientTarget) =>
  module.targets.includes(target) && (contribution.targets as readonly ClientTarget[]).includes(target)

/** Every catalog contribution `pick` accepts. A module that omits its contributions declares none. */
const declared = (modules: readonly ClientModule[], pick: (entry: Declared) => boolean): Declared[] =>
  modules.flatMap((module) =>
    (module.contributions ?? []).map((contribution) => ({ module, contribution })).filter(pick),
  )

/** The single declaration of `found` that serves `target`; one bundle per target may each declare it. */
function one(found: readonly Declared[], target: ClientTarget, what: string): Outcome<Declared> {
  const [entry, ...rest] = found.filter((entry) => serves(entry, target))
  if (!entry && found.length > 0) return refuse('client_selection_target', `${what} does not serve ${target}`)
  if (!entry) return refuse('client_selection_missing', `${what} is not in the module catalog`)
  if (rest.length > 0) return refuse('client_selection_ambiguous', `${what} is declared more than once`)
  return { ok: true, value: entry }
}

const selected = ({ module, contribution }: Declared): SelectedContribution => ({
  moduleId: module.moduleId,
  packageId: module.packageId,
  packageDigest: module.packageDigest,
  entryPath: module.entryPath,
  contributionId: contribution.contributionId,
})

const sameSet = (left: readonly string[], right: readonly string[]) => {
  const items = new Set(left)
  return items.size === new Set(right).size && right.every((item) => items.has(item))
}

/**
 * `found` as a selected renderer, when the descriptor it declares describes it: its own id, its package
 * generation, the targets the contribution declares and, for a row, the render key the row selects.
 */
function described(found: Declared, renderKey?: string): Outcome<SelectedRenderer> {
  const { module, contribution } = found
  const descriptor = contribution.kind === 'renderer' ? contribution.descriptor : undefined
  if (
    descriptor?.id !== contribution.contributionId ||
    descriptor.packageDigest !== module.packageDigest ||
    !sameSet(descriptor.targets, contribution.targets) ||
    (renderKey !== undefined && descriptor.renderKey !== renderKey)
  )
    return refuse(
      'client_selection_descriptor',
      `renderer ${contribution.contributionId} of package ${module.packageId} declares a descriptor that does not describe it`,
    )
  return { ok: true, value: { ...selected(found), descriptor } }
}

export function resolveClientSelection(input: {
  target: ClientTarget
  selection: ClientSelection | undefined
  modules: readonly ClientModule[]
}): Outcome<ResolvedClientSelection> {
  const { target, selection, modules } = input
  // A welcome from an older server has no selection; guessing one would pick a client it never chose.
  if (selection === undefined) return { ok: true, value: { kind: 'legacy' } }
  const rows = selection.rendererSelections
  if (selection.target !== target || rows.some((row) => row.target !== target))
    return refuse('client_selection_target', `the selection is not for the ${target} client`)
  if (new Set(rows.map((row) => row.renderKey)).size !== rows.length)
    return refuse('client_selection_ambiguous', 'a render key is selected more than once')

  // ponytail: rescans the catalog per package, fine at the wire limit of 128 modules.
  const mixed = (packageId: string) =>
    new Set(modules.filter((module) => module.packageId === packageId).map((module) => module.packageDigest))
      .size > 1
  const generations = (packageId: string) =>
    refuse('client_selection_digest', `package ${packageId} has two generations in the module catalog`)
  for (const ref of [selection.shell, selection.registry, selection.fallbackRenderer])
    if (ref && mixed(ref.packageId)) return generations(ref.packageId)

  const resolve = (what: string, ref: Ref, kind: ClientModuleContribution['kind']) =>
    one(
      declared(
        modules,
        ({ module, contribution }) =>
          module.packageId === ref.packageId &&
          contribution.contributionId === ref.contributionId &&
          contribution.kind === kind,
      ),
      target,
      `${what} ${ref.packageId}/${ref.contributionId}`,
    )
  // The wire requires the export on every shell and registry declaration; a renderer has none.
  const service = (found: Declared): SelectedService => ({
    ...selected(found),
    export: found.contribution.kind === 'renderer' ? '' : found.contribution.export,
  })
  let shell: SelectedService | null = null
  if (selection.shell) {
    const found = resolve('shell', selection.shell, 'shell')
    if (!found.ok) return found
    shell = service(found.value)
  }
  const registry = resolve('registry', selection.registry, 'registry')
  if (!registry.ok) return registry
  const fallback = resolve('fallback renderer', selection.fallbackRenderer, 'renderer')
  if (!fallback.ok) return fallback
  const fallbackRenderer = described(fallback.value)
  if (!fallbackRenderer.ok) return fallbackRenderer

  // A row names no package, so its renderer id must name one contribution across the whole catalog.
  const renderers: Array<{ renderKey: string; renderer: SelectedRenderer }> = []
  for (const row of rows) {
    const found = one(
      declared(
        modules,
        ({ contribution }) =>
          contribution.kind === 'renderer' && contribution.contributionId === row.rendererId,
      ),
      target,
      `renderer ${row.rendererId}`,
    )
    if (!found.ok) return found
    const { packageId } = found.value.module
    if (mixed(packageId)) return generations(packageId)
    const renderer = described(found.value, row.renderKey)
    if (!renderer.ok) return renderer
    renderers.push({ renderKey: row.renderKey, renderer: renderer.value })
  }
  return {
    ok: true,
    value: {
      kind: 'selected',
      target,
      shell,
      registry: service(registry.value),
      fallbackRenderer: fallbackRenderer.value,
      renderers,
    },
  }
}
