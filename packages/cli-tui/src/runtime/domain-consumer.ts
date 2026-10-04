// Presents runtime domain views in the terminal through an injected text formatter, the pure function
// the other text clients share. Every server string loses its control and format characters before it
// reaches a line. An offered action is shown as `[n] label`, and the number maps back to its action key,
// never to its label. Only the action kinds this client can carry out are offered: answering an
// interaction, downloading an artifact and opening a form. A command action needs an owner token and an
// expected revision this client does not hold yet, so it is shown as unavailable. A view the formatter
// cannot present shows only its fallback text; its data is never printed.
import type {
  DomainView,
  FormattedView,
  NegotiatedClientCapabilities,
  RuntimeError,
  TextRendererFormatContext,
  ViewAction,
} from '@agnes/protocol/runtime'
import { escapeServerText } from '../component.js'
import { t } from '../locale.js'

const OFFERED = ['interaction', 'download', 'open-form'] as const

export type FormatDomainView = (
  view: DomainView,
  context: Readonly<TextRendererFormatContext>,
) => { ok: true; value: FormattedView } | { ok: false; error: RuntimeError }
export type OfferedActionKind = (typeof OFFERED)[number]
export type PresentedView = Readonly<{
  viewId: string
  revision: number
  lines: readonly string[]
  /** Numbers are valid only for this revision of this view. */
  actions: readonly Readonly<{ n: number; actionKey: string; kind: OfferedActionKind }>[]
  complete: boolean
  /** Part of the view cannot be used here; the user finishes it in the Web client. No link is fetched. */
  needsWeb: boolean
}>

const offered = (kind: string): kind is OfferedActionKind => (OFFERED as readonly string[]).includes(kind)
const lines = (text: string) => escapeServerText(text).split('\n')
const oneLine = (text: string) => escapeServerText(text).replace(/\n/g, ' ')

export function createDomainConsumer(options: {
  format: FormatDomainView
  locale: string
  capabilities: NegotiatedClientCapabilities
}) {
  const { format, locale, capabilities } = options
  // Insertion order is screen order; a newer revision takes its view's existing place.
  const shown = new Map<string, { view: DomainView; presented: PresentedView }>()

  const fallback = (view: DomainView): PresentedView => ({
    viewId: view.viewId,
    revision: view.revision,
    lines: [...lines(view.fallbackText), t('runtime.view.unavailable', locale)],
    actions: [],
    complete: false,
    needsWeb: true,
  })

  function build(view: DomainView): PresentedView {
    // A formatter that throws, refuses or returns a malformed result leaves only the fallback text.
    try {
      const outcome = format(view, { locale, capabilities })
      if (!outcome.ok) return fallback(view)
      const formatted = outcome.value
      if (formatted.viewId !== view.viewId || formatted.revision !== view.revision) return fallback(view)
      const out: string[] = []
      const actions: { n: number; actionKey: string; kind: OfferedActionKind }[] = []
      for (const part of formatted.parts) {
        if (part.kind === 'text') {
          out.push(...lines(part.text))
          continue
        }
        // A key shared by two actions cannot be mapped back safely, so neither is offered. A disabled action
        // is never offered, whatever an injected formatter emits for it.
        const matches = view.actions.filter((action) => action.actionKey === part.actionKey)
        const action = matches.length === 1 ? matches[0] : undefined
        const label = oneLine(part.label)
        if (action?.availability === 'enabled' && offered(action.kind)) {
          actions.push({ n: actions.length + 1, actionKey: action.actionKey, kind: action.kind })
          out.push(`[${actions.length}] ${label}`)
        } else out.push(t('runtime.view.actionUnavailable', locale, { label }))
      }
      const complete = formatted.complete === true
      if (!complete) {
        const missing = formatted.unsupportedRequiredFeatures.map(oneLine)
        if (missing.length > 0)
          out.push(t('runtime.view.missingFeatures', locale, { features: missing.join(', ') }))
        out.push(t('runtime.view.needsWeb', locale))
      }
      const { viewId, revision } = view
      return { viewId, revision, lines: out, actions, complete, needsWeb: !complete }
    } catch {
      return fallback(view)
    }
  }

  return {
    /** The view's presentation. A revision no newer than the one shown changes nothing. */
    present(view: DomainView): PresentedView {
      const seen = shown.get(view.viewId)
      if (seen && seen.presented.revision >= view.revision) return seen.presented
      const presented = build(view)
      shown.set(view.viewId, { view, presented })
      return presented
    },
    views(): PresentedView[] {
      return [...shown.values()].map((entry) => entry.presented)
    },
    /** The action number `n` named on the screen showing `revision`; nothing once the view has moved on. */
    select(viewId: string, revision: number, n: number): ViewAction | undefined {
      const seen = shown.get(viewId)
      if (!seen || seen.presented.revision !== revision) return undefined
      const shownAction = seen.presented.actions.find((action) => action.n === n)
      return shownAction && seen.view.actions.find((action) => action.actionKey === shownAction.actionKey)
    },
  }
}
