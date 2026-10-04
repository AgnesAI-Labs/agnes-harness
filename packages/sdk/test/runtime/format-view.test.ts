import {
  type DomainView,
  type FormattedView,
  type IMRendererEncodeChannel,
  type NegotiatedClientCapabilities,
  type TextRendererFormatContext,
  type ViewAction,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { encodeForChannel, formatDomainView } from '@agnes/sdk/runtime'
import { describe, expect, it } from 'vitest'

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
  ...base,
  kind: 'command',
  actionKey: 'archive',
  label: 'Archive',
  availability: 'disabled',
  disabledReason: 'Locked by an editor',
  command: 'archive-command',
  inputSchema: schema,
}
const review: ViewAction = {
  ...base,
  kind: 'open-form',
  actionKey: 'review',
  label: 'Review',
  requiredFeatures: ['forms.complex'],
  interactionId: 'interaction-secret',
  version: 2,
}

function view(extra: Partial<DomainView> = {}): DomainView {
  const value: DomainView = {
    kind: 'domain',
    viewId: 'note-1',
    revision: 3,
    domainType: 'acme.notes',
    viewSchema: { typeId: 'acme.notes/view@1', revision: 1, digest: 'b'.repeat(64) },
    renderKey: 'acme.notes/card',
    scope: {
      kind: 'session',
      installationId: 'install-1',
      runtimeId: 'runtime-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
    },
    source: { eventIds: ['event-1'], projectionRevision: 5 },
    phase: 'provisional',
    fallbackText: 'Draft note',
    data: { approval: 'approval-secret', html: '<b>x</b>' },
    resources: [
      { artifactId: 'file-1', version: 1, title: 'a.txt', mime: 'text/plain', size: 1, status: 'ready' },
      {
        artifactId: 'file-2',
        version: 4,
        title: 'b.png',
        mime: 'image/png',
        size: 9,
        status: 'pending-publish',
      },
    ],
    actions: [publish, archive],
    ...extra,
  }
  expect(validateRuntime('DomainView', value).ok).toBe(true)
  return value
}

const context = (features: string[] = []): TextRendererFormatContext => ({
  locale: 'en',
  capabilities: {
    clientInstanceId: 'client-1',
    target: 'tui',
    features,
  } as unknown as NegotiatedClientCapabilities,
})

function format(value: unknown, features: string[] = []): FormattedView {
  const outcome = formatDomainView(value as DomainView, context(features))
  if (!outcome.ok) throw new Error(outcome.error.message)
  expect(validateRuntime('FormattedView', outcome.value).ok).toBe(true)
  return outcome.value
}

const offered = (formatted: FormattedView) =>
  formatted.parts.flatMap((part) => (part.kind === 'action' ? [part.actionKey] : []))
const shown = (formatted: FormattedView) =>
  formatted.parts.map((part) => (part.kind === 'text' ? part.text : part.label)).join('\n')
const bytes = (text: string) => new TextEncoder().encode(text).length
const channel = (maxTextBytes: number, supportsButtons = true): IMRendererEncodeChannel => ({
  kind: 'test-chat',
  maxTextBytes,
  supportsButtons,
})

function encode(formatted: FormattedView, at: IMRendererEncodeChannel) {
  const outcome = encodeForChannel(formatted, at)
  if (!outcome.ok) throw new Error(outcome.error.message)
  expect(validateRuntime('IMRendererEncodeResult', outcome.value).ok).toBe(true)
  const { messages } = outcome.value
  expect(messages.map(({ partIndex, partCount }) => [partIndex, partCount])).toEqual(
    messages.map((_, index) => [index, messages.length]),
  )
  for (const message of messages) {
    expect(bytes(message.text)).toBeLessThanOrEqual(at.maxTextBytes)
    expect(message.actionKeys.every((key) => offered(formatted).includes(key))).toBe(true)
  }
  return outcome.value
}

describe('formatDomainView', () => {
  it('shows status, fallback text, resources and actions in the generic card order', () => {
    expect(format(view())).toEqual({
      viewId: 'note-1',
      revision: 3,
      complete: true,
      unsupportedRequiredFeatures: [],
      parts: [
        { kind: 'text', text: 'Status: In progress' },
        { kind: 'text', text: 'Draft note' },
        { kind: 'text', text: 'Resources:' },
        { kind: 'text', text: '- a.txt' },
        { kind: 'text', text: '- b.png' },
        { kind: 'text', text: 'Actions:' },
        { kind: 'action', actionKey: 'publish', label: 'Publish' },
        { kind: 'text', text: 'Archive: Locked by an editor' },
      ],
    })
  })

  it.each([
    ['provisional', 'Status: In progress'],
    ['finalized', 'Status: Final'],
    ['interrupted', 'Status: Interrupted, may be incomplete'],
  ] as const)('names the %s phase', (phase, status) => {
    expect(format(view({ phase, resources: [], actions: [] })).parts).toEqual([
      { kind: 'text', text: status },
      { kind: 'text', text: 'Draft note' },
    ])
  })

  it('offers enabled actions only and shows disabled ones as text', () => {
    const quiet: ViewAction = { ...archive, actionKey: 'quiet', label: 'Quiet', disabledReason: null }
    const formatted = format(view({ actions: [archive, publish, quiet] }))
    expect(offered(formatted)).toEqual(['publish'])
    expect(formatted.parts.slice(-3)).toEqual([
      { kind: 'text', text: 'Archive: Locked by an editor' },
      { kind: 'action', actionKey: 'publish', label: 'Publish' },
      { kind: 'text', text: 'Quiet: Not available here.' },
    ])
  })

  it.each([
    {
      name: 'missing feature',
      features: [],
      complete: false,
      unsupported: ['forms.complex'],
      keys: ['publish'],
    },
    {
      name: 'negotiated feature',
      features: ['forms.complex'],
      complete: true,
      unsupported: [],
      keys: ['publish', 'review'],
    },
  ])('marks an enabled action that needs a $name', ({ features, complete, unsupported, keys }) => {
    // The disabled action's feature asks nothing of the client.
    const blocked: ViewAction = { ...archive, requiredFeatures: ['never.negotiated'] }
    const formatted = format(view({ actions: [publish, review, review, blocked] }), features)
    expect(formatted).toMatchObject({ complete, unsupportedRequiredFeatures: unsupported })
    expect(new Set(offered(formatted))).toEqual(new Set(keys))
  })

  it('reads every feature as missing when the context lists none', () => {
    const outcome = formatDomainView(view({ actions: [review] }), {
      locale: 'en',
    } as TextRendererFormatContext)
    expect(outcome).toMatchObject({
      ok: true,
      value: { complete: false, unsupportedRequiredFeatures: ['forms.complex'] },
    })
  })

  it('keeps view text plain and leaves identifiers and data out of it', () => {
    // Format characters such as bidirectional overrides, isolates, zero widths and BOMs are removed;
    // the zero width joiner of an emoji sequence stays.
    const fallbackText =
      'Hi \x1b[31mred\r\nnext\x07 <b>bold</b> **x** \u202Eevil\u202C \u2067rtl\u2069 a\u200Bb\uFEFF \u{1F469}\u200D\u{1F4BB}'
    const download: ViewAction = {
      ...base,
      kind: 'download',
      actionKey: 'get',
      label: 'G\u202Eet',
      artifactId: 'artifact-secret',
      version: 1,
    }
    const formatted = format(view({ fallbackText, actions: [publish, review, download] }), ['forms.complex'])
    expect(formatted.parts[1]).toEqual({
      kind: 'text',
      text: 'Hi �[31mred\nnext� <b>bold</b> **x** evil rtl ab \u{1F469}\u200D\u{1F4BB}',
    })
    expect(formatted.parts.at(-1)).toEqual({ kind: 'action', actionKey: 'get', label: 'Get' })
    for (const secret of [
      'approval-secret',
      'interaction-secret',
      'artifact-secret',
      'publish-command',
      'file-1',
    ])
      expect(shown(formatted)).not.toContain(secret)
  })

  // A readable action stays offered when another part of the view is unreadable.
  it.each([
    ['an unknown phase', { phase: 'paused' }, 'Status: Unknown', ['publish']],
    ['no fallback text', { fallbackText: undefined }, 'Status: Final', ['publish']],
    ['resources that are not a list', { resources: 'a.txt' }, 'Status: Final', ['publish']],
    ['an unreadable resource', { resources: [null, { artifactId: 'file-9' }] }, 'Status: Final', ['publish']],
    ['an action without a key', { actions: [{ ...publish, actionKey: undefined }] }, 'Status: Final', []],
    ['an action of an unknown kind', { actions: [{ ...publish, kind: 'script' }] }, 'Status: Final', []],
    ['an action without a label', { actions: [{ ...publish, label: 7 }] }, 'Status: Final', []],
    ['too many actions', { actions: Array.from({ length: 33 }, () => archive) }, 'Status: Final', []],
  ])('shows what it can of a view with %s and marks it incomplete', (_, change, status, keys) => {
    const value = { ...view({ phase: 'finalized' }), ...change }
    const formatted = format(value)
    expect(formatted.complete).toBe(false)
    expect(formatted.parts[0]).toEqual({ kind: 'text', text: status })
    expect(offered(formatted)).toEqual(keys)
  })

  it('shows a malformed action by its label without offering it', () => {
    const formatted = format({ ...view(), actions: [{ ...publish, availability: 'maybe' }] })
    expect(formatted.complete).toBe(false)
    expect(formatted.parts.at(-1)).toEqual({ kind: 'text', text: 'Publish: Not available here.' })
  })

  it.each([
    ['null', null],
    ['a string', 'Draft note'],
    ['a list', [view()]],
    ['another kind', { ...view(), kind: 'conversation' }],
    ['no view id', { ...view(), viewId: undefined }],
    ['no revision', { ...view(), revision: Number.NaN }],
  ])('refuses %s', (_, input) => {
    const outcome = formatDomainView(input as DomainView, context())
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', retryAdvice: { kind: 'never' } },
    })
    if (!outcome.ok) expect(validateRuntime('RuntimeError', outcome.error).ok).toBe(true)
  })

  it('returns the same result for the same input and leaves the input unchanged', () => {
    const value = view({ actions: [publish, archive, review] })
    const before = structuredClone(value)
    const first = formatDomainView(value, context())
    expect(formatDomainView(value, context())).toEqual(first)
    expect(value).toEqual(before)
    if (!first.ok) throw new Error('format refused')
    const formatted = structuredClone(first.value)
    expect(encodeForChannel(first.value, channel(16))).toEqual(encodeForChannel(first.value, channel(16)))
    expect(first.value).toEqual(formatted)
  })
})

describe('encodeForChannel', () => {
  const formatted = format(view())

  it('sends a view that fits as one message with its buttons', () => {
    expect(encode(formatted, channel(4096))).toEqual({
      complete: true,
      requiresWebForm: false,
      messages: [
        {
          text: 'Status: In progress\nDraft note\nResources:\n- a.txt\n- b.png\nActions:\nArchive: Locked by an editor',
          actionKeys: ['publish'],
          partIndex: 0,
          partCount: 1,
        },
      ],
    })
  })

  it('sends action labels as text when the channel has no buttons', () => {
    const { messages } = encode(formatted, channel(4096, false))
    expect(messages).toHaveLength(1)
    expect(messages[0]?.actionKeys).toEqual([])
    expect(messages[0]?.text).toContain('Actions:\nPublish\nArchive: Locked by an editor')
  })

  it('starts a new message at the byte limit and puts each button in the message it falls in', () => {
    const parts: FormattedView['parts'] = [
      { kind: 'text', text: 'aaaa' },
      { kind: 'action', actionKey: 'one', label: 'One' },
      { kind: 'text', text: 'bbbb' },
      { kind: 'text', text: 'cccc' },
      { kind: 'action', actionKey: 'two', label: 'Two' },
    ]
    const split = { viewId: 'v', revision: 1, parts, complete: true, unsupportedRequiredFeatures: [] }
    expect(encode(split, channel(9)).messages.map(({ text, actionKeys }) => [text, actionKeys])).toEqual([
      ['aaaa\nbbbb', ['one']],
      ['cccc', ['two']],
    ])
    expect(encode(split, channel(9, false)).messages.map(({ text }) => text)).toEqual([
      'aaaa\nOne',
      'bbbb\ncccc',
      'Two',
    ])
  })

  it.each([
    ['ascii', 'a'.repeat(100)],
    ['two-byte', 'é'.repeat(50)],
    ['three-byte', '中文'.repeat(30)],
    ['emoji', `${'😀'.repeat(25)}x`],
    ['mixed', 'a😀é中'.repeat(20)],
  ])('cuts long %s text on character boundaries', (_, text) => {
    const long = {
      viewId: 'v',
      revision: 1,
      parts: [{ kind: 'text' as const, text }],
      complete: true,
      unsupportedRequiredFeatures: [],
    }
    for (const limit of [4, 5, 7, 16]) {
      const { messages } = encode(long, channel(limit))
      expect(messages.length).toBeGreaterThan(1)
      expect(messages.map((message) => message.text).join('')).toBe(text)
      // A broken surrogate pair or multi-byte character does not survive a UTF-8 round trip.
      for (const message of messages)
        expect(new TextDecoder().decode(new TextEncoder().encode(message.text))).toBe(message.text)
    }
  })

  it('offers only the view action keys and asks for the Web form when the view is incomplete', () => {
    const partial = format(view({ actions: [publish, review, archive] }))
    for (const at of [channel(4096), channel(8)]) {
      const encoded = encode(partial, at)
      expect(encoded).toMatchObject({ complete: false, requiresWebForm: true })
      expect(encoded.messages.flatMap((message) => message.actionKeys)).toEqual(['publish'])
    }
  })

  it.each([
    ['zero', 0],
    ['three bytes', 3],
    ['negative', -16],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['fractional', 16.5],
    ['a string', '4096'],
  ])('refuses a %s limit', (_, maxTextBytes) => {
    const outcome = encodeForChannel(formatted, { ...channel(4), maxTextBytes } as IMRendererEncodeChannel)
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', retryAdvice: { kind: 'never' } },
    })
  })

  it.each([
    ['parts that are not a list', { ...formatted, parts: 'text' }],
    ['a part of an unknown kind', { ...formatted, parts: [{ kind: 'html', text: '<b>x</b>' }] }],
    ['an action part without a key', { ...formatted, parts: [{ kind: 'action', label: 'Go' }] }],
  ])('refuses %s', (_, input) => {
    const outcome = encodeForChannel(input as FormattedView, channel(4096))
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', retryAdvice: { kind: 'never' } },
    })
  })
})
