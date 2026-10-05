// Maps one domain view to the `agh.channel` send messages for one channel conversation. The text
// renderer is injected, so this package presents with whatever IM renderer the client selected. The
// mapping is pure: it copies only the renderer's text and the keys of actions the view itself offers,
// never view data, approval values, tokens or URLs. A view the channel cannot present completely
// becomes a read-only summary marked incomplete, and the caller sends the user to the Web form.
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest, utf8ByteLength, validateRuntime } from '@agnes/protocol/runtime'

const KINDS: readonly string[] = ['command', 'interaction', 'download', 'open-form']

type Outcome<T> = { ok: true; value: T } | { ok: false; error: Wire.RuntimeError }

/** The `format` and `encode` of the IM renderer the channel presents with. */
export interface ChannelTextRenderer {
  format(
    view: Wire.DomainView,
    context: Readonly<Wire.TextRendererFormatContext>,
  ): Outcome<Wire.FormattedView>
  encode(
    formatted: Wire.FormattedView,
    channel: Readonly<Wire.IMRendererEncodeChannel>,
  ): Outcome<Wire.IMRendererEncodeResult>
}

export interface DomainViewDelivery {
  view: Wire.DomainView
  /** The question the view asks, which must be one of its own interaction or form actions; or null. */
  interaction: Wire.ChannelMessage['interaction']
  destination: Wire.ChannelDestination
  channel: Wire.IMRendererEncodeChannel
  context: Wire.TextRendererFormatContext
  renderer: ChannelTextRenderer
}

/** With `requiresWebForm` the messages offer no action and the user answers in the Web form. */
export type ChannelMessages = { messages: Wire.ChannelMessage[]; requiresWebForm: boolean }

const refuse = (detailCode: string, message: string): { ok: false; error: Wire.RuntimeError } => ({
  ok: false,
  error: {
    code: 'invalid_input',
    detailCode,
    message,
    retryAdvice: { kind: 'never' },
    diagnosticId: 'channels-domain-consumer',
  },
})

const digest = (value: Wire.JsonValue): string | undefined => {
  try {
    return canonicalJsonDigest(value)
  } catch {
    return undefined
  }
}

export function toChannelMessages(input: DomainViewDelivery): Outcome<ChannelMessages> {
  const { view, interaction, destination, channel, renderer } = input
  if (
    interaction !== null &&
    !view.actions.some(
      (action) =>
        (action.kind === 'interaction' || action.kind === 'open-form') &&
        action.interactionId === interaction.interactionId &&
        action.version === interaction.version,
    )
  )
    return refuse('foreign_interaction', 'the interaction is not one the view asks')
  // A renderer that throws, as one whose plugin was disabled under the channel may, or that answers with
  // anything but an outcome is a refusal too.
  const call = <T>(run: () => Outcome<T>): Outcome<T> => {
    let result: { ok?: unknown; error?: unknown } | null | undefined
    try {
      result = run()
    } catch {}
    return result?.ok === true ||
      (result?.ok === false && typeof result.error === 'object' && result.error !== null)
      ? (result as Outcome<T>)
      : refuse('renderer_failed', 'the renderer failed')
  }
  const formatted = call(() => renderer.format(view, input.context))
  if (!formatted.ok) return formatted
  const full = formatted.value
  if (
    !validateRuntime('FormattedView', full).ok ||
    full.viewId !== view.viewId ||
    full.revision !== view.revision
  )
    return refuse('invalid_formatted_view', 'the renderer did not format this view')
  const encode = (at: Wire.IMRendererEncodeChannel): Outcome<Wire.IMRendererEncodeResult> => {
    const result = call(() => renderer.encode(full, at))
    return !result.ok ||
      (validateRuntime('IMRendererEncodeResult', result.value).ok && result.value.messages.length > 0)
      ? result
      : refuse('invalid_encoding', 'the renderer encoded no valid messages')
  }
  let encoded = encode(channel)
  if (!encoded.ok) return encoded
  const requiresWebForm =
    !full.complete ||
    full.unsupportedRequiredFeatures.length > 0 ||
    !encoded.value.complete ||
    encoded.value.requiresWebForm
  // Without buttons the renderer sends action labels as text: the summary stays readable but answers nothing.
  if (requiresWebForm && channel.supportsButtons) encoded = encode({ ...channel, supportsButtons: false })
  if (!encoded.ok) return encoded

  // A button may only carry the key of an action of a known kind the view offers enabled and whose every
  // required feature the channel negotiated, labelled as the renderer formatted it.
  const negotiated: unknown = input.context?.capabilities?.features
  const features: readonly unknown[] = Array.isArray(negotiated) ? negotiated : []
  const offered = new Set(
    view.actions.flatMap((action) =>
      action.availability === 'enabled' &&
      KINDS.includes(action.kind) &&
      Array.isArray(action.requiredFeatures) &&
      action.requiredFeatures.every((feature) => features.includes(feature))
        ? [action.actionKey]
        : [],
    ),
  )
  const labels = new Map<string, string>()
  for (const part of full.parts)
    if (!requiresWebForm && part.kind === 'action' && offered.has(part.actionKey))
      labels.set(part.actionKey, part.label)
  // Every part shares the digest of the whole presentation; the attachments of this version are none.
  const fullContentDigest = digest({
    viewId: view.viewId,
    viewRevision: view.revision,
    content: full,
    interaction,
    attachments: [],
  })
  const parts = encoded.value.messages
  const messages: Wire.ChannelMessage[] = []
  for (const [partIndex, part] of parts.entries()) {
    if (part.partIndex !== partIndex || part.partCount !== parts.length)
      return refuse('invalid_encoding', 'the renderer numbered its messages out of order')
    if (!utf8ByteLength(part.text, channel.maxTextBytes).ok)
      return refuse('message_too_long', 'a message exceeds the channel text limit')
    const actions: Wire.TextPart[] = []
    for (const actionKey of part.actionKeys) {
      const label = labels.get(actionKey)
      if (label === undefined)
        return refuse('foreign_action', 'a message offers an action the view does not offer')
      actions.push({ kind: 'action', actionKey, label })
    }
    // A value with a lone surrogate has no digest; the empty id and digest fail the schema check below.
    const message: Wire.ChannelMessage = {
      messageId: digest({ destination, viewId: view.viewId, viewRevision: view.revision, partIndex }) ?? '',
      destination,
      viewId: view.viewId,
      viewRevision: view.revision,
      content: {
        viewId: full.viewId,
        revision: full.revision,
        parts: [{ kind: 'text', text: part.text }, ...actions],
        complete: !requiresWebForm,
        unsupportedRequiredFeatures: full.unsupportedRequiredFeatures,
      },
      interaction,
      partIndex,
      partCount: parts.length,
      fullContentDigest: fullContentDigest ?? '',
    }
    if (!validateRuntime('ChannelMessage', message).ok)
      return refuse('invalid_message', 'the view cannot be addressed as a channel message')
    messages.push(message)
  }
  return { ok: true, value: { messages, requiresWebForm } }
}
