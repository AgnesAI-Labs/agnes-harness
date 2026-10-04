// Presents a domain view through a renderer the client host leased. Only the passed view's id and
// revision are read: the renderer sees, and its context is bounded by, the copy the current authorized
// window holds under that id at that revision, and that copy must fit the renderer's descriptor for this
// client's target. A Web view mounts one restricted context per lease and view, moved in place to newer
// revisions, under a boundary that shows the view's fallback text when the renderer throws. A text view
// is only formatted; encoding and sending stay with the channel. Disposing a lease releases only what
// that lease mounted.
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
import { Component, type ReactNode, useEffect, useMemo } from 'react'
import type { ClientTarget } from './client-selection.js'
import { createRendererContext, type MountedRendererContext } from './renderer-context.js'

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

/** Why `definition` cannot present `view` to `target`, or undefined when it can. */
function mismatch(
  definition: RendererDefinition,
  descriptor: RendererDescriptor | undefined,
  view: DomainView,
  target: ClientTarget,
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
    // The view states its features per action; the renderer presents every action, disabled ones too.
    const known = [...descriptor.requiredFeatures, ...descriptor.optionalFeatures]
    const missing = view.actions.flatMap((action) => action.requiredFeatures).find((f) => !known.includes(f))
    if (missing !== undefined) return `the renderer does not support feature ${missing}`
  } catch {
    return 'the renderer descriptor is malformed'
  }
  return undefined
}

class Guard extends Component<{ fallbackText: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override render(): ReactNode {
    // Text only: a failed renderer leaves the view's own fallback, never its thrown value.
    if (this.state.failed) return <p className="renderer-fallback">{this.props.fallbackText}</p>
    return this.props.children
  }
}

function Presented({
  open,
  component: Renderer,
  view,
}: {
  open: (view: DomainView) => MountedRendererContext
  component: WebRendererDefinition['component']
  view: DomainView
}) {
  // One context per lease: a newer revision is moved into it, and another lease presenting under the
  // same key opens its own while the effect disposes the old one.
  // ponytail: a StrictMode remount would find this context disposed; recreate it in the effect if a
  // StrictMode host appears.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the view is opened once and moved by update.
  const mounted = useMemo(() => open(view), [open])
  // Before the renderer renders, so its own effects already see the newer restriction.
  mounted.update(view)
  useEffect(() => () => void mounted.dispose(), [mounted])
  return (
    <Guard fallbackText={view.fallbackText}>
      <Renderer view={view} context={mounted.context} />
    </Guard>
  )
}

export function createRendererPresenter(input: {
  target: ClientTarget
  clientInstanceId: string
  capabilities: NegotiatedClientCapabilities
  locale: string
  services: Pick<RendererContext, 'commands' | 'interactions' | 'artifacts' | 'locale'>
  views: AuthorizedViews
}): {
  /** One lease for a definition the host bound under `ownerToken`. */
  lease(binding: { definition: RendererDefinition; ownerToken: string }): {
    present(view: DomainView): Outcome<RendererPresentation>
    /** Refuses every later present and disposes each context this lease still has mounted. Idempotent. */
    dispose(): Promise<void>
  }
} {
  const { target, clientInstanceId, capabilities, services, views } = input
  return {
    lease({ definition, ownerToken }) {
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
      const open = (view: DomainView) => {
        const mounted = createRendererContext({ clientInstanceId, ownerToken, capabilities, services, view })
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
          const reason = mismatch(definition, descriptor, shown, target)
          if (reason !== undefined) return refuse('incompatible', 'renderer_mismatch', reason)

          if (target === 'web') {
            const { component } = definition as WebRendererDefinition
            const key = JSON.stringify([ownerToken, shown.viewId])
            return {
              ok: true,
              value: {
                target,
                element: <Presented key={key} open={open} component={component} view={shown} />,
              },
            }
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
          await Promise.all([...live].map((mounted) => mounted.dispose()))
        },
      }
    },
  }
}
