import {
  type DomainView,
  type FormattedView,
  type NegotiatedClientCapabilities,
  type ViewAction,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { createDomainConsumer, type FormatDomainView } from '../../src/runtime/domain-consumer.js'

const base = { requiredFeatures: [], availability: 'enabled' as const, disabledReason: null }
const schema = { typeId: 'acme.notes/input@1', revision: 1, digest: 'a'.repeat(64) }
// Each label is another action's key, so a consumer that confused the two would pick the wrong one.
const answer: ViewAction = {
  ...base,
  kind: 'interaction',
  actionKey: 'save',
  label: 'answer',
  interactionId: 'q-1',
  version: 2,
}
const save: ViewAction = {
  ...base,
  kind: 'download',
  actionKey: 'answer',
  label: 'save',
  artifactId: 'file-1',
  version: 1,
}
const review: ViewAction = {
  ...base,
  kind: 'open-form',
  actionKey: 'review',
  label: 'Review',
  interactionId: 'q-2',
  version: 1,
}
const later: ViewAction = {
  ...answer,
  actionKey: 'later',
  label: 'Later',
  availability: 'disabled',
  disabledReason: 'Locked',
}
const publish: ViewAction = {
  ...base,
  kind: 'command',
  actionKey: 'publish',
  label: 'Publish',
  command: 'publish-command',
  inputSchema: schema,
}

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
    phase: 'finalized',
    fallbackText: 'Draft note',
    data: { secret: 'data-secret' },
    resources: [],
    actions: [answer, save, review, publish, later],
    ...extra,
  }
  expect(validateRuntime('DomainView', value).ok).toBe(true)
  return value
}

// Stands in for the shared text formatter: the fallback text, then every action as an action part.
const plain: FormatDomainView = (input) => ({
  ok: true,
  value: {
    viewId: input.viewId,
    revision: input.revision,
    parts: [
      { kind: 'text', text: input.fallbackText },
      ...input.actions.map((action) => ({
        kind: 'action' as const,
        actionKey: action.actionKey,
        label: action.label,
      })),
    ],
    complete: true,
    unsupportedRequiredFeatures: [],
  },
})
const capabilities = { target: 'tui', features: [] } as unknown as NegotiatedClientCapabilities
const consumer = (format: FormatDomainView = plain, locale = 'en') =>
  createDomainConsumer({ format, locale, capabilities })

describe('runtime domain consumer', () => {
  it('formats through the SDK text format unless another format is injected', () => {
    const shown = createDomainConsumer({ locale: 'en', capabilities }).present(view())
    expect(shown.lines).toEqual([
      'Status: Final',
      'Draft note',
      'Actions:',
      '[1] answer',
      '[2] save',
      '[3] Review',
      'Publish (not available in the terminal)',
      'Later: Locked',
    ])
    expect(shown.actions.map(({ n, actionKey }) => [n, actionKey])).toEqual([
      [1, 'save'],
      [2, 'answer'],
      [3, 'review'],
    ])
    expect(shown.complete).toBe(true)
  })

  it('numbers offered actions and maps a number back by action key, never by label', () => {
    const tui = consumer()
    const shown = tui.present(view())
    expect(shown.lines).toEqual([
      'Draft note',
      '[1] answer',
      '[2] save',
      '[3] Review',
      'Publish (not available in the terminal)',
      'Later (not available in the terminal)',
    ])
    expect(shown.actions).toEqual([
      { n: 1, actionKey: 'save', kind: 'interaction' },
      { n: 2, actionKey: 'answer', kind: 'download' },
      { n: 3, actionKey: 'review', kind: 'open-form' },
    ])
    expect(tui.select('note-1', 3, 1)).toEqual(answer)
    expect(tui.select('note-1', 3, 2)).toEqual(save)
    // A command action has no number, and numbers past the screen select nothing.
    expect(tui.select('note-1', 3, 4)).toBeUndefined()
    expect(shown).toMatchObject({ complete: true, needsWeb: false })
  })

  it('offers neither action when two actions share a key', () => {
    const twin: ViewAction = { ...review, label: 'Other' }
    const shown = consumer().present(view({ actions: [review, twin] }))
    expect(shown.actions).toEqual([])
    expect(shown.lines.slice(1)).toEqual([
      'Review (not available in the terminal)',
      'Other (not available in the terminal)',
    ])
  })

  it('strips control and format characters from every server string', () => {
    const label = 'Open\x1b[2J\u202e\u200bForm\nnow'
    const shown = consumer().present(
      view({ fallbackText: 'a\x1b]8;;evil\x07b\u2066c\r\nd\x9b', actions: [{ ...review, label }] }),
    )
    expect(shown.lines).toEqual(['a]8;;evilbc', 'd', '[1] Open[2JForm now'])
    for (const line of shown.lines) expect(line).not.toMatch(/[\p{Cc}\p{Cf}]/u)
  })

  it.each<[string, FormatDomainView]>([
    [
      'throws',
      () => {
        throw new Error('renderer crashed')
      },
    ],
    [
      'refuses',
      () => ({
        ok: false,
        error: {
          code: 'invalid_input',
          detailCode: 'not_a_view',
          message: 'no',
          retryAdvice: { kind: 'never' },
          diagnosticId: 'd-1',
        },
      }),
    ],
    [
      'returns a malformed result',
      (input) => ({ ok: true, value: { viewId: input.viewId, revision: input.revision } as FormattedView }),
    ],
    [
      'answers for another view',
      (input) => plain({ ...input, viewId: 'other' }, { locale: 'en', capabilities }),
    ],
  ])('shows only the sanitized fallback text when the formatter %s', (_name, format) => {
    for (const [locale, notice] of [
      ['en', 'This view cannot be shown in the terminal.'],
      ['zh-CN', '此视图无法在终端显示。'],
    ] as const) {
      const shown = consumer(format, locale).present(view({ fallbackText: 'Draft\u202e note' }))
      expect(shown).toEqual({
        viewId: 'note-1',
        revision: 3,
        lines: ['Draft note', notice],
        actions: [],
        complete: false,
        needsWeb: true,
      })
      expect(shown.lines.join('\n')).not.toContain('data-secret')
    }
  })

  it('names missing features and sends an incomplete view to the Web without fetching a link', () => {
    const incomplete: FormatDomainView = (input, context) => {
      const outcome = plain(input, context)
      if (!outcome.ok) return outcome
      return {
        ok: true,
        value: { ...outcome.value, complete: false, unsupportedRequiredFeatures: ['forms.complex'] },
      }
    }
    const shown = consumer(incomplete).present(view({ actions: [review] }))
    expect(shown.lines).toEqual([
      'Draft note',
      '[1] Review',
      'Needs features this terminal lacks: forms.complex',
      'Finish this in the Web client.',
    ])
    expect(shown).toMatchObject({ complete: false, needsWeb: true })
  })

  it('replaces a view in place on a newer revision and ignores an older one', () => {
    const tui = consumer()
    tui.present(view())
    tui.present(view({ viewId: 'note-2', fallbackText: 'Second' }))
    const newer = tui.present(view({ revision: 4, fallbackText: 'Edited', actions: [review] }))
    expect(newer.lines).toEqual(['Edited', '[1] Review'])
    expect(tui.present(view({ revision: 2, fallbackText: 'Stale' }))).toBe(newer)
    expect(tui.views().map((shown) => [shown.viewId, shown.revision, shown.lines[0]])).toEqual([
      ['note-1', 4, 'Edited'],
      ['note-2', 3, 'Second'],
    ])
    // A number read off the replaced screen no longer selects anything.
    expect(tui.select('note-1', 3, 1)).toBeUndefined()
    expect(tui.select('note-1', 4, 1)).toEqual(review)
  })
})
