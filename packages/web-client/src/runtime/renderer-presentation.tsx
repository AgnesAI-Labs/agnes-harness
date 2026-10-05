// Presents a domain view through a renderer the client host leased. Only the passed view's id and
// revision are read: the renderer sees, and its context is bounded by, the copy the current authorized
// window holds under that id at that revision, and that copy must fit the renderer's descriptor for this
// client's target. A Web view mounts one restricted context per lease and view, moved in place to newer
// revisions, under a boundary: when the renderer throws, its context closes, the failure is reported by
// ids only and the view switches to the generic card, or to its fallback text if that throws. A text view
// is only formatted; encoding and sending stay with the channel. Disposing a lease releases only what
// that lease mounted. The built-in generic lease presents any view the window holds with the safe Web
// card or the default text format, so basic information shows without any plugin bundle. One view index
// per presenter lets every context it opens for a view, in any lease or generation, read the status of
// what any of them sent for that view.
import type {
  DomainView,
  FormattedView,
  NegotiatedClientCapabilities,
  Outcome,
  RendererContext,
  RendererDefinition,
  RendererDescriptor,
  RendererPresentation,
  RuntimeError,
  TextRenderer,
  WebRendererDefinition,
} from '@agnes/extension-api/client'
import { formatDomainView } from '@agnes/sdk/runtime'
import { Component, type ReactNode, useLayoutEffect, useState } from 'react'
import type { ClientTarget } from './client-selection.js'
import { createRendererContext, createViewIndex, type MountedRendererContext } from './renderer-context.js'
import { GenericDomainView } from './renderers/generic.js'

export interface AuthorizedViews {
  /** The view the current authorized window holds under this id, or undefined when the window has none. */
  current(viewId: string): DomainView | undefined
}

const refuse = (
  code: RuntimeError['code'],
  detailCode: string,
  message: string,
  retry: 'never' | 'retry_read' = 'never',
): { ok: false; error: RuntimeError } => ({
  ok: false,
  error: {
    code,
    detailCode,
    message,
    retryAdvice: { kind: retry },
    diagnosticId: 'web-client-renderer-presentation',
  },
})
// Like any resync: the client rereads the window before it presents again.
const resync = (detailCode: string, message: string) => refuse('conflict', detailCode, message, 'retry_read')

const text = (error: unknown) => (error instanceof Error ? error.message : String(error))

// The built-in view, presented like a renderer but never held to a descriptor: it reads any view.
const GENERIC = { component: GenericDomainView, format: formatDomainView } as unknown as RendererDefinition
const GENERIC_OWNER = 'web-client-generic'

/** Why `definition` cannot present `view` to `target`, or undefined when it can. */
function mismatch(
  definition: RendererDefinition,
  descriptor: RendererDescriptor | undefined,
  view: DomainView,
  target: ClientTarget,
  negotiated: readonly string[],
): string | undefined {
  const has = (part: string) => typeof (definition as unknown as Record<string, unknown>)[part] === 'function'
  if (!(target === 'web' ? has('component') : has('format') && (target !== 'im' || has('encode'))))
    return `the renderer cannot present to ${target}`
  if (descriptor === undefined) return 'the renderer descriptor could not be read'
  try {
    const { typeId, revision } = view.viewSchema
    if (!descriptor.targets.includes(target)) return `the renderer does not declare ${target}`
    if (descriptor.renderKey !== view.renderKey) return `the renderer does not render ${view.renderKey}`
    const reads = descriptor.viewSchemaRanges.some(
      (range) => range.typeId === typeId && range.minRevision <= revision && revision <= range.maxRevision,
    )
    if (!reads) return `the renderer does not read ${typeId} revision ${revision}`
    // A renderer that needs a feature this client did not negotiate is not compatible with it.
    const unnegotiated = descriptor.requiredFeatures.find((feature) => !negotiated.includes(feature))
    if (unnegotiated !== undefined) return `the client did not negotiate feature ${unnegotiated}`
    // The view states its features per action; the renderer presents every action, disabled ones too.
    const known = [...descriptor.requiredFeatures, ...descriptor.optionalFeatures]
    const missing = view.actions.flatMap((action) => action.requiredFeatures).find((f) => !known.includes(f))
    if (missing !== undefined) return `the renderer does not support feature ${missing}`
  } catch {
    return 'the renderer descriptor is malformed'
  }
  return undefined
}

class Guard extends Component<
  { fallback: ReactNode; onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override componentDidCatch() {
    this.props.onError()
  }

  override render(): ReactNode {
    // A failed renderer leaves its fallback, never its thrown value.
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function Presented({
  open,
  component: Renderer,
  view,
  fallback,
  failed,
}: {
  open: (view: DomainView) => MountedRendererContext
  component: WebRendererDefinition['component']
  view: DomainView
  /** What the view shows once the renderer threw. */
  fallback: ReactNode
  failed?: () => void
}) {
  // The context opens when this element commits and closes when it unmounts, so a render React discards
  // (after a renderer throws, say) opens nothing. One context per lease: a newer revision is moved into
  // it, and another lease presenting under the same key opens its own while the old one closes.
  const [mounted, setMounted] = useState<MountedRendererContext>()
  // biome-ignore lint/correctness/useExhaustiveDependencies: the view is opened once and moved by update.
  useLayoutEffect(() => {
    const opened = open(view)
    setMounted(opened)
    return () => void opened.dispose()
  }, [open])
  if (mounted === undefined) return null
  // Before the renderer renders, so its own effects already see the newer restriction.
  mounted.update(view)
  return (
    <Guard
      fallback={fallback}
      onError={() => {
        // The failed renderer's context closes now, so its old closures are refused.
        void mounted.dispose()
        failed?.()
      }}
    >
      <Renderer view={view} context={mounted.context} />
    </Guard>
  )
}

interface RendererLease {
  present(view: DomainView): Outcome<RendererPresentation>
  /**
   * Refuses every later present and disposes each context this lease still has mounted; resolves whether
   * every one closed within its dispose deadline. Idempotent.
   */
  dispose(): Promise<boolean>
}

export function createRendererPresenter(input: {
  target: ClientTarget
  clientInstanceId: string
  capabilities: NegotiatedClientCapabilities
  locale: string
  services: Pick<RendererContext, 'commands' | 'interactions' | 'artifacts' | 'locale'>
  views: AuthorizedViews
  /** Told, with ids only, that a Web renderer threw and its view switched to the generic card. */
  onFailure?: (failure: { rendererId: string; viewId: string }) => void
  /** The deadline a disposed context holds draining and its cleanups to; 5 000 ms by default. */
  limits?: { disposeMs?: number }
}): {
  /** One lease for a definition the host bound under `ownerToken`. */
  lease(binding: { definition: RendererDefinition; ownerToken: string }): RendererLease
  /** One lease for the built-in generic view, which presents any view the window holds. */
  generic(): RendererLease
  /**
   * Forgets a request or response id of `viewId` whose effect stays unknown, after the user confirmed
   * it loses the local follow-up; false when the id is not unknown there. The server keeps the command.
   */
  archive(viewId: string, kind: 'request' | 'response', id: string): boolean
} {
  const { target, clientInstanceId, capabilities, services, views } = input
  // A capability set without a feature list negotiated none.
  const negotiated: readonly string[] = Array.isArray(capabilities?.features) ? capabilities.features : []
  // What every context the presenter opens shares, its view index among it.
  const shared = { clientInstanceId, capabilities, services, index: createViewIndex() }
  const disposeMs = input.limits?.disposeMs ?? 5_000
  /** A lease presenting through `definition`; a plugin renderer must also fit the view (`checked`). */
  function bind(definition: RendererDefinition, ownerToken: string, checked: boolean): RendererLease {
    // Read once, so a definition changed after it was bound does not move what it may present.
    let descriptor: RendererDescriptor | undefined
    try {
      descriptor = structuredClone(definition.descriptor)
    } catch {}
    const live = new Set<MountedRendererContext>()
    let released = false

    // ponytail: the calling shell or module's grant and the renderer contribution's grant are not on
    // the wire yet, so only the view's own offers (and the services' own checks) bound a context today;
    // intersect those grants here once the selection carries them.
    const opener = (ownerToken: string) => (view: DomainView) => {
      const mounted = createRendererContext({ ...shared, ownerToken, view, disposeMs })
      if (released) {
        void mounted.dispose()
        return mounted
      }
      live.add(mounted)
      mounted.context.onDispose(() => {
        live.delete(mounted)
      })
      return mounted
    }
    const open = opener(ownerToken)
    // The generic card that replaces a failed renderer is the lease's own, so releasing the lease ends it.
    const openGeneric = opener(GENERIC_OWNER)
    const report = (viewId: string) => {
      try {
        input.onFailure?.({ rendererId: String(descriptor?.id), viewId })
      } catch {
        // A failing report leaves the view on the generic card all the same.
      }
    }

    return {
      present(view) {
        if (released) return refuse('cancelled', 'renderer_released', 'the renderer lease was released')
        const viewId = view?.viewId
        const revision = view?.revision
        const current = typeof viewId === 'string' ? views.current(viewId) : undefined
        if (current === undefined)
          return resync('view_resync_required', 'the authorized window does not hold the view')
        if (current.revision !== revision)
          return resync('view_stale', `the authorized window holds revision ${current.revision}`)
        // A copy, so a renderer cannot change what the window holds.
        const shown = structuredClone(current)
        const reason = checked ? mismatch(definition, descriptor, shown, target, negotiated) : undefined
        if (reason !== undefined) return refuse('incompatible', 'renderer_mismatch', reason)

        if (target === 'web') {
          const { component } = definition as WebRendererDefinition
          // Another definition presenting the same view mounts afresh, a newer revision updates in place.
          const key = JSON.stringify([ownerToken, descriptor?.id ?? null, shown.viewId])
          // A renderer that throws yields to the generic card, and the generic card to the text.
          const plain = <p className="renderer-fallback">{shown.fallbackText}</p>
          const element =
            definition === GENERIC ? (
              <Presented key={key} open={open} component={component} view={shown} fallback={plain} />
            ) : (
              <Presented
                key={key}
                open={open}
                component={component}
                view={shown}
                fallback={
                  <Presented open={openGeneric} component={GenericDomainView} view={shown} fallback={plain} />
                }
                failed={() => report(shown.viewId)}
              />
            )
          return { ok: true, value: { target, element } }
        }
        let formatted: Outcome<FormattedView>
        try {
          formatted = (definition as TextRenderer).format(shown, {
            locale: input.locale,
            capabilities: structuredClone(capabilities),
          })
        } catch (error) {
          return refuse('internal', 'renderer_failed', `the renderer threw: ${text(error)}`)
        }
        if (formatted?.ok !== true)
          return refuse('internal', 'renderer_failed', `the renderer refused: ${formatted?.error?.message}`)
        if (formatted.value?.viewId !== shown.viewId || formatted.value.revision !== shown.revision)
          return refuse('internal', 'renderer_failed', 'the renderer formatted another view')
        return { ok: true, value: { target, formatted: formatted.value } }
      },
      async dispose() {
        released = true
        return (await Promise.all([...live].map((mounted) => mounted.dispose()))).every(Boolean)
      },
    }
  }
  return {
    lease: ({ definition, ownerToken }) => bind(definition, ownerToken, true),
    generic: () => bind(GENERIC, GENERIC_OWNER, false),
    archive: (viewId, kind, id) => shared.index.archive(viewId, kind, id),
  }
}
