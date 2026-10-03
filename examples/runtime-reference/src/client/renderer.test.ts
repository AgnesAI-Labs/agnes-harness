import { type DomainView, validateRuntime } from '@agnes/protocol/runtime'
import { describe, expect, it, vi } from 'vitest'
import { referenceRenderers } from './index.js'
import { ReferenceOutline } from './presentation-renderer.js'
import {
  encodeOutline,
  formatOutline,
  OUTLINE_RENDER_KEY,
  OUTLINE_VIEW_TYPE,
  referenceOutlineText,
  referenceOutlineWeb,
} from './renderer.js'
import { createReferenceUIRegistry } from './ui-registry.js'

const inputSchema = { typeId: 'reference.outline/approve@1', revision: 1, digest: 'a'.repeat(64) }
const command = (actionKey: string, requiredFeatures: string[] = []) => ({
  kind: 'command' as const,
  actionKey,
  label: actionKey === 'approve' ? 'Approve' : 'Revise',
  requiredFeatures,
  availability: 'enabled' as const,
  disabledReason: null,
  command: actionKey,
  inputSchema,
})

function outlineView(data: unknown, extra: Partial<DomainView> = {}): DomainView {
  const view = {
    kind: 'domain',
    viewId: 'outline-1',
    revision: 2,
    domainType: 'reference.outline',
    viewSchema: { typeId: OUTLINE_VIEW_TYPE, revision: 1, digest: 'b'.repeat(64) },
    renderKey: OUTLINE_RENDER_KEY,
    scope: {
      kind: 'session',
      installationId: 'install-1',
      runtimeId: 'runtime-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
    },
    source: { eventIds: ['event-1'], projectionRevision: 3 },
    phase: 'finalized',
    fallbackText: 'fallback is not used',
    data,
    resources: [],
    actions: [command('approve'), command('revise', ['rich-edit'])],
    ...extra,
  } as DomainView
  expect(validateRuntime('DomainView', view).ok).toBe(true)
  return view
}

const outline = {
  title: 'Launch plan',
  revision: 4,
  slides: [
    { heading: 'Goals', points: ['Ship', 'Learn'] },
    { heading: 'Risks', points: [] },
  ],
}
const capabilities = (features: string[] = ['rich-edit'], maxTextBytes = 4096) => ({
  locale: 'en',
  capabilities: { features, display: { maxTextBytes } },
})

const format = (view: DomainView, context = capabilities()) => {
  const formatted = formatOutline(view, context).value
  expect(validateRuntime('FormattedView', formatted).ok).toBe(true)
  return formatted
}
const formattedText = (text: string, complete = true) => ({
  viewId: 'outline-1',
  revision: 2,
  parts: [
    { kind: 'text' as const, text },
    { kind: 'action' as const, actionKey: 'approve', label: 'Approve' },
  ],
  complete,
  unsupportedRequiredFeatures: [],
})
const encode = (
  formatted: ReturnType<typeof formattedText>,
  maxTextBytes: number,
  supportsButtons = true,
) => {
  const encoded = encodeOutline(formatted, { kind: 'chat', maxTextBytes, supportsButtons }).value
  expect(validateRuntime('IMRendererEncodeResult', encoded).ok).toBe(true)
  return encoded
}
const bytes = (text: string) => new TextEncoder().encode(text).length

describe('reference outline renderer', () => {
  it('formats text and action parts from the view data', () => {
    expect(format(outlineView(outline))).toEqual({
      viewId: 'outline-1',
      revision: 2,
      parts: [
        { kind: 'text', text: 'Launch plan' },
        { kind: 'text', text: '1. Goals\n- Ship\n- Learn' },
        { kind: 'text', text: '2. Risks' },
        { kind: 'action', actionKey: 'approve', label: 'Approve' },
        { kind: 'action', actionKey: 'revise', label: 'Revise' },
      ],
      complete: true,
      unsupportedRequiredFeatures: [],
    })
    expect(format(outlineView(outline, { phase: 'interrupted' })).parts[0]).toEqual({
      kind: 'text',
      text: 'Launch plan (interrupted)',
    })
  })

  it.each([
    ['an unknown data field', outlineView({ ...outline, theme: 'dark' }), capabilities(), 5, []],
    ['a feature the client lacks', outlineView(outline), capabilities([]), 4, ['rich-edit']],
    ['text past the display limit', outlineView(outline), capabilities(['rich-edit'], 30), 3, []],
    ['data that is not an outline', outlineView({ title: 'x' }), capabilities(), 0, []],
  ])('marks the result incomplete for %s', (_name, view, context, parts, unsupported) => {
    const formatted = format(view, context)
    expect(formatted.complete).toBe(false)
    expect(formatted.parts).toHaveLength(parts)
    expect(formatted.unsupportedRequiredFeatures).toEqual(unsupported)
    expect(JSON.stringify(formatted)).not.toContain('fallback')
  })

  it('splits IM text by UTF-8 bytes between characters and keeps the view action keys', () => {
    // Euro sign: 3 bytes; grinning face: 4 bytes and two UTF-16 units.
    const text = 'ab\u20ac\u20ac\u{1F600}c'
    const encoded = encode(formattedText(text), 5)
    expect(encoded.messages.map((message) => message.text)).toEqual(['ab\u20ac', '\u20ac', '\u{1F600}c'])
    expect(encoded.messages.every((message) => bytes(message.text) <= 5)).toBe(true)
    expect(
      encoded.messages.map(({ actionKeys, partIndex, partCount }) => [actionKeys, partIndex, partCount]),
    ).toEqual([
      [[], 0, 3],
      [[], 1, 3],
      [['approve'], 2, 3],
    ])
    expect(encoded).toMatchObject({ complete: true, requiresWebForm: false })

    const plain = encode(formattedText('Plan'), 100, false)
    expect(plain.messages).toEqual([
      { text: 'Plan\n\nActions: Approve', actionKeys: ['approve'], partIndex: 0, partCount: 1 },
    ])
  })

  it.each([
    ['a character wider than a message', formattedText('\u20ac'), 2, 0],
    ['more parts than one chat should take', formattedText('x'.repeat(50)), 2, 10],
    ['an incomplete formatted view', formattedText('Plan', false), 100, 1],
  ])('asks for the Web form for %s', (_name, formatted, maxTextBytes, count) => {
    const encoded = encode(formatted, maxTextBytes)
    expect(encoded).toMatchObject({ complete: false, requiresWebForm: true })
    expect(encoded.messages).toHaveLength(count)
  })

  it('renders the outline on the Web and submits a command once per click', async () => {
    const submit = vi.fn(async () => ({ ok: true }))
    const element = ReferenceOutline({
      view: outlineView(outline, { phase: 'provisional' }),
      context: { commands: { submit } },
    })
    const nodes: { type: unknown; props: Record<string, unknown> }[] = []
    const walk = (node: unknown): string => {
      if (Array.isArray(node)) return node.map(walk).join('|')
      if (typeof node === 'string' || typeof node === 'number') return String(node)
      if (typeof node !== 'object' || node === null) return ''
      const element = node as (typeof nodes)[number]
      nodes.push(element)
      return walk(element.props.children)
    }
    expect(walk(element)).toBe('Launch plan| (draft)|Goals|Ship|Learn|Risks||Approve|Revise')
    const approve = nodes.find((node) => node.type === 'button' && node.props.children === 'Approve')
    const click = approve?.props.onClick as () => void
    click()
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: { viewId: 'outline-1', actionKey: 'approve', viewRevision: 2 },
        commandSchema: inputSchema,
        expectedRevision: 4,
      }),
    )
  })

  it('registers its Web and text definitions with valid descriptors', () => {
    expect(Object.values(referenceRenderers)).toEqual([referenceOutlineWeb, referenceOutlineText])
    for (const definition of [referenceOutlineWeb, referenceOutlineText])
      expect(validateRuntime('RendererDescriptor', definition.descriptor).ok).toBe(true)
    const made = createReferenceUIRegistry({
      bindRenderer: (definition: typeof referenceOutlineWeb | typeof referenceOutlineText) => ({
        ok: true,
        value: definition,
      }),
    })
    if (!made.ok) throw new Error(made.error.message)
    for (const definition of [referenceOutlineWeb, referenceOutlineText])
      expect(made.value.register(definition).ok).toBe(true)
    const viewSchema = { typeId: OUTLINE_VIEW_TYPE, revision: 1 }
    const resolve = (target: 'web' | 'im') =>
      made.value.resolve({ renderKey: OUTLINE_RENDER_KEY, viewSchema, target, requiredFeatures: [] })
    expect(resolve('web')).toMatchObject({
      ok: true,
      value: { kind: 'matched', handle: referenceOutlineWeb },
    })
    expect(resolve('im')).toMatchObject({
      ok: true,
      value: { kind: 'matched', handle: referenceOutlineText },
    })
  })
})
