import type {
  ChannelDestination,
  ChannelMessage,
  DomainView,
  IMRendererEncodeChannel,
  NegotiatedClientCapabilities,
  TextPart,
  TextRendererFormatContext,
  ViewAction,
} from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { describe, expect, it, vi } from 'vitest'
import { type ChannelTextRenderer, toChannelMessages } from '../../src/runtime/domain-consumer.js'

const schema = { typeId: 'acme.notes/publish@1', revision: 1, digest: 'a'.repeat(64) }
const base = { requiredFeatures: [], availability: 'enabled' as const, disabledReason: null }
const publish: ViewAction = {
  ...base,
  kind: 'command',
  actionKey: 'publish',
  label: 'Publish',
  command: 'publish-command',
  inputSchema: schema,
}
const archive: ViewAction = {
  ...publish,
  actionKey: 'archive',
  label: 'Archive',
  availability: 'disabled',
  disabledReason: 'Locked',
}
const answer: ViewAction = {
  ...base,
  kind: 'interaction',
  actionKey: 'answer',
  label: 'Answer',
  interactionId: 'question-1',
  version: 2,
}
const review: ViewAction = {
  ...answer,
  kind: 'open-form',
  actionKey: 'review',
  label: 'Review',
  requiredFeatures: ['forms.complex'],
}
const question = { interactionId: 'question-1', version: 2 }

function view(extra: Partial<DomainView> = {}): DomainView {
  const value: DomainView = {
    kind: 'domain',
    viewId: 'note-1',
    revision: 3,
    domainType: 'acme.notes',
    viewSchema: { typeId: 'acme.notes/view@1', revision: 1, digest: 'b'.repeat(64) },
    renderKey: 'acme.notes/card',
    scope: { kind: 'workspace', installationId: 'install-1', runtimeId: 'runtime-1', workspaceId: 'ws-1' },
    source: { eventIds: ['event-1'], projectionRevision: 5 },
    phase: 'provisional',
    fallbackText: 'Draft note',
    data: { approval: 'approval-secret', link: 'https://example.invalid/grant?token=t0ken' },
    resources: [],
    actions: [publish, archive, answer],
    ...extra,
  }
  expect(validateRuntime('DomainView', value).ok).toBe(true)
  return value
}

const destination: ChannelDestination = {
  channelId: 'dingtalk',
  accountId: 'account-1',
  conversationId: 'chat-1',
  threadId: null,
}
const context = (features: string[] = []): TextRendererFormatContext => ({
  locale: 'en',
  capabilities: {
    clientInstanceId: 'im-1',
    target: 'im',
    features,
  } as unknown as NegotiatedClientCapabilities,
})
const channel = (maxTextBytes = 64, supportsButtons = true): IMRendererEncodeChannel => ({
  kind: 'test-chat',
  maxTextBytes,
  supportsButtons,
})

// A stand-in IM renderer: the parts as lines, cut into ASCII pieces of the byte limit, buttons on the last piece.
const renderer: ChannelTextRenderer = {
  format(value, at) {
    const negotiated = new Set(at.capabilities.features)
    const unsupported = new Set<string>()
    const parts: TextPart[] = [{ kind: 'text', text: value.fallbackText }]
    for (const action of value.actions) {
      const enabled = action.availability === 'enabled'
      const missing = enabled ? action.requiredFeatures.filter((feature) => !negotiated.has(feature)) : []
      for (const feature of missing) unsupported.add(feature)
      parts.push(
        enabled && missing.length === 0
          ? { kind: 'action', actionKey: action.actionKey, label: action.label }
          : { kind: 'text', text: `${action.label}: not available` },
      )
    }
    const complete = unsupported.size === 0
    return {
      ok: true,
      value: {
        viewId: value.viewId,
        revision: value.revision,
        parts,
        complete,
        unsupportedRequiredFeatures: [...unsupported],
      },
    }
  },
  encode(formatted, at) {
    const lines = formatted.parts.flatMap((part) =>
      part.kind === 'text' ? [part.text] : at.supportsButtons ? [] : [part.label],
    )
    const texts = lines.join('\n').match(new RegExp(`.{1,${at.maxTextBytes}}`, 'gs')) ?? ['']
    const keys = at.supportsButtons
      ? formatted.parts.flatMap((part) => (part.kind === 'action' ? [part.actionKey] : []))
      : []
    const messages = texts.map((text, partIndex) => ({
      text,
      actionKeys: partIndex === texts.length - 1 ? keys : [],
      partIndex,
      partCount: texts.length,
    }))
    return {
      ok: true,
      value: { messages, complete: formatted.complete, requiresWebForm: !formatted.complete },
    }
  },
}

function deliver(
  options: {
    value?: DomainView
    features?: string[]
    at?: IMRendererEncodeChannel
    with?: Partial<ChannelTextRenderer>
    interaction?: ChannelMessage['interaction']
  } = {},
) {
  return toChannelMessages({
    view: options.value ?? view(),
    interaction: options.interaction === undefined ? question : options.interaction,
    destination,
    channel: options.at ?? channel(),
    context: context(options.features),
    renderer: { ...renderer, ...options.with },
  })
}

function messages(outcome: ReturnType<typeof deliver>): ChannelMessage[] {
  if (!outcome.ok) throw new Error(outcome.error.detailCode)
  for (const message of outcome.value.messages)
    expect(validateRuntime('ChannelMessage', message).ok).toBe(true)
  return outcome.value.messages
}

function refused(outcome: ReturnType<typeof deliver>): string {
  if (outcome.ok) throw new Error('expected a refusal')
  expect(validateRuntime('RuntimeError', outcome.error).ok).toBe(true)
  return outcome.error.detailCode
}

const textOf = (message: ChannelMessage) => (message.content.parts[0] as { text: string }).text
const offered = (message: ChannelMessage) =>
  message.content.parts.flatMap((part) => (part.kind === 'action' ? [part.actionKey] : []))

describe('toChannelMessages', () => {
  it('sends text and the keys of enabled view actions, never view data, ids or links', () => {
    const outcome = deliver()
    const [message] = messages(outcome)
    expect(outcome.ok && outcome.value.requiresWebForm).toBe(false)
    expect(message).toMatchObject({ destination, viewId: 'note-1', viewRevision: 3, interaction: question })
    expect(message?.content.parts).toEqual([
      { kind: 'text', text: 'Draft note\nArchive: not available' },
      { kind: 'action', actionKey: 'publish', label: 'Publish' },
      { kind: 'action', actionKey: 'answer', label: 'Answer' },
    ])
    const sent = JSON.stringify(outcome)
    for (const secret of ['approval-secret', 'publish-command', 'token', 'https://'])
      expect(sent).not.toContain(secret)
    expect(deliver()).toEqual(outcome)
  })

  it('cuts the view into parts within the channel byte limit that share one content digest', () => {
    const value = view({ fallbackText: 'x'.repeat(40) })
    const parts = messages(deliver({ value, at: channel(16) }))
    expect(parts.length).toBeGreaterThan(2)
    expect(parts.map(({ partIndex, partCount }) => [partIndex, partCount])).toEqual(
      parts.map((_, index) => [index, parts.length]),
    )
    for (const part of parts) expect(new TextEncoder().encode(textOf(part)).length).toBeLessThanOrEqual(16)
    expect(new Set(parts.map((part) => part.messageId)).size).toBe(parts.length)
    const formatted = renderer.format(value, context())
    if (!formatted.ok) throw new Error('format failed')
    const fullContentDigest = canonicalJsonDigest({
      viewId: 'note-1',
      viewRevision: 3,
      content: formatted.value,
      interaction: question,
      attachments: [],
    })
    expect(
      parts.every((part) => part.fullContentDigest === fullContentDigest && part.interaction === question),
    ).toBe(true)
    expect(offered(parts.at(-1) as ChannelMessage)).toEqual(['publish', 'answer'])

    const overlong = deliver({
      with: {
        encode: () => ({
          ok: true,
          value: {
            messages: [{ text: 'é'.repeat(9), actionKeys: [], partIndex: 0, partCount: 1 }],
            complete: true,
            requiresWebForm: false,
          },
        }),
      },
      at: channel(16),
    })
    expect(refused(overlong)).toBe('message_too_long')
  })

  it('sends a read-only summary and requires the Web form when a required feature is unsupported', () => {
    const value = view({ actions: [publish, review] })
    const outcome = deliver({ value, interaction: { interactionId: 'question-1', version: 2 } })
    const parts = messages(outcome)
    expect(outcome.ok && outcome.value.requiresWebForm).toBe(true)
    expect(parts.flatMap(offered)).toEqual([])
    expect(parts.every((part) => !part.content.complete)).toBe(true)
    expect(parts[0]?.content.unsupportedRequiredFeatures).toEqual(['forms.complex'])
    expect(parts[0]?.content.parts).toEqual([
      { kind: 'text', text: 'Draft note\nPublish\nReview: not available' },
    ])

    expect(messages(deliver({ value, features: ['forms.complex'] })).flatMap(offered)).toEqual([
      'publish',
      'review',
    ])

    const encode = vi.fn<ChannelTextRenderer['encode']>((formatted, at) => {
      const result = renderer.encode(formatted, at)
      return result.ok ? { ok: true, value: { ...result.value, requiresWebForm: true } } : result
    })
    const declared = deliver({ with: { encode } })
    expect(declared.ok && declared.value.requiresWebForm).toBe(true)
    expect(messages(declared).flatMap(offered)).toEqual([])
    expect(encode.mock.calls.map(([, at]) => at.supportsButtons)).toEqual([true, false])
  })

  it('refuses renderer output for other actions or views and questions the view does not ask', () => {
    const encoded = (actionKeys: string[]) => ({
      encode: () => ({
        ok: true as const,
        value: {
          messages: [{ text: 'Note', actionKeys, partIndex: 0, partCount: 1 }],
          complete: true,
          requiresWebForm: false,
        },
      }),
    })
    expect(refused(deliver({ with: encoded(['delete']) }))).toBe('foreign_action')
    expect(refused(deliver({ with: encoded(['archive']) }))).toBe('foreign_action')
    const other = deliver({
      with: { format: (value, at) => renderer.format({ ...value, viewId: 'note-2' }, at) },
    })
    expect(refused(other)).toBe('invalid_formatted_view')
    expect(refused(deliver({ interaction: { interactionId: 'question-1', version: 1 } }))).toBe(
      'foreign_interaction',
    )
    expect(messages(deliver({ interaction: null }))[0]?.interaction).toBeNull()
  })
})
