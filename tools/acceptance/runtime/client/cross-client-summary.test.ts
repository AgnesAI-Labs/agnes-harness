/** @vitest-environment happy-dom */
// One domain view, as the authorized projection hands it to a client, shown on every client surface: the
// Web client's generic card (the built-in presentation for a view no renderer presents), the SDK text
// format, the terminal consumer and the chat channel mapping. Every surface must mean the same thing,
// and nothing outside the view's display text may reach any of them. Each surface's own tests pin its
// layout; this test only compares the surfaces with each other.

import { describe, expect, it, vi } from 'vitest'
import { toChannelMessages } from '../../../../packages/channels/src/runtime/domain-consumer.js'
import { t } from '../../../../packages/cli-tui/src/locale.js'
import { createDomainConsumer } from '../../../../packages/cli-tui/src/runtime/domain-consumer.js'
import {
  type DomainView,
  type NegotiatedClientCapabilities,
  type ViewAction,
  validateRuntime,
} from '../../../../packages/protocol/src/runtime/index.js'
import { encodeForChannel, formatDomainView } from '../../../../packages/sdk/src/runtime/format-view.js'
import { createRendererPresenter } from '../../../../packages/web-client/src/runtime/renderer-presentation.js'
import { createAntdRoot } from '../../../../packages/web-ui/src/antd-root.js'

// Values no surface may show. Each sits in the view's data or in a field that is not display text.
const SECRET = {
  token: 'tok_live_7Hq2Zr9VwK',
  credential: 'sk-proj-Q4mT8xLd2Vn6',
  url: 'https://files.example.test/signed/a91f?sig=c3d4e5',
  command: 'notes.internal.publish-v7',
  interaction: 'interaction-8c1e-approval',
  artifact: 'artifact-5b2d-confidential',
  download: 'artifact-0f9a-export',
  session: 'session-77d0-private',
  workspace: 'workspace-3e4f-private',
  event: 'event-6a6a-ledger',
  stream: 'stream-2c2c-live',
}
const SECRETS = Object.values(SECRET)

type Surface = 'web' | 'tui' | 'im'
const NEGOTIATED = ['choice.single']
const capabilities = (target: Surface | 'sdk') =>
  ({ clientInstanceId: 'client-1', target, features: NEGOTIATED }) as unknown as NegotiatedClientCapabilities

const schema = { typeId: 'acme.notes/publish@1', revision: 1, digest: 'a'.repeat(64) }
const TARGETS = {
  command: { command: SECRET.command, inputSchema: schema },
  interaction: { interactionId: SECRET.interaction, version: 2 },
  download: { artifactId: SECRET.download, version: 1 },
  'open-form': { interactionId: SECRET.interaction, version: 2 },
}
// Labels hold no ': ', which the text format puts between a label and why it is unavailable.
const action = (kind: ViewAction['kind'], label: string, extra: Partial<ViewAction> = {}) =>
  ({
    kind,
    actionKey: label.toLowerCase().replaceAll(' ', '-'),
    label,
    requiredFeatures: [],
    availability: 'enabled',
    disabledReason: null,
    ...TARGETS[kind],
    ...extra,
  }) as ViewAction

type Shown = Pick<DomainView, 'phase' | 'fallbackText' | 'resources' | 'actions'> & Partial<DomainView>
const view = (viewId: string, shown: Shown): DomainView => ({
  kind: 'domain',
  viewId,
  revision: 1,
  domainType: 'acme.notes',
  viewSchema: { typeId: 'acme.notes/view@1', revision: 1, digest: 'b'.repeat(64) },
  renderKey: 'acme.notes/card',
  scope: {
    kind: 'session',
    installationId: 'install-1',
    runtimeId: 'runtime-1',
    workspaceId: SECRET.workspace,
    sessionId: SECRET.session,
  },
  source: { eventIds: [SECRET.event], projectionRevision: 7 },
  data: {
    token: SECRET.token,
    credential: SECRET.credential,
    link: SECRET.url,
    next: { command: SECRET.command },
  },
  ...shown,
})

const VIEWS: [string, DomainView][] = [
  [
    'a finalized view with resources and an enabled action of each kind',
    view('notes-final', {
      phase: 'finalized',
      fallbackText: 'Quarterly notes published',
      resources: [
        {
          artifactId: SECRET.artifact,
          version: 3,
          title: 'Quarterly notes.pdf',
          mime: 'application/pdf',
          size: 2048,
          status: 'ready',
        },
        // Without a title every surface names the resource by its artifact id.
        { artifactId: 'notes-appendix', version: 1, title: null, mime: null, size: null, status: 'reserved' },
      ],
      actions: [
        action('command', 'Publish'),
        action('interaction', 'Approve'),
        action('download', 'Download'),
        action('open-form', 'Review'),
      ],
    }),
  ],
  [
    'a provisional view with a disabled action of each kind',
    view('notes-draft', {
      phase: 'provisional',
      stream: { streamId: SECRET.stream, generation: 1, revision: 4 },
      fallbackText: 'Drafting the quarterly notes',
      resources: [
        {
          artifactId: SECRET.artifact,
          version: 4,
          title: 'Draft notes.md',
          mime: 'text/markdown',
          size: 12,
          status: 'pending-publish',
        },
      ],
      actions: [
        action('command', 'Publish', { availability: 'disabled', disabledReason: 'Waiting for the draft' }),
        action('interaction', 'Approve', { availability: 'disabled' }),
        action('download', 'Download', { availability: 'disabled', disabledReason: 'Still uploading' }),
        action('open-form', 'Review', { availability: 'disabled' }),
      ],
    }),
  ],
  [
    'an interrupted view with text only',
    view('notes-stopped', {
      phase: 'interrupted',
      fallbackText: 'Notes stopped before the summary',
      resources: [],
      actions: [],
    }),
  ],
  [
    'a view whose form needs a feature the client did not negotiate',
    view('notes-form', {
      phase: 'finalized',
      fallbackText: 'The notes need a review',
      resources: [],
      actions: [
        action('interaction', 'Choose reviewer', { requiredFeatures: ['choice.single'] }),
        action('open-form', 'Open review form', { requiredFeatures: ['forms.complex'] }),
        action('download', 'Download'),
      ],
    }),
  ],
  [
    'a view whose command needs a feature the client did not negotiate',
    view('notes-batch', {
      phase: 'finalized',
      fallbackText: 'The notes are ready to send',
      resources: [],
      actions: [
        action('command', 'Send to all', { requiredFeatures: ['commands.batch'] }),
        action('command', 'Archive'),
      ],
    }),
  ],
]

// What a surface means by a view, read back from what it shows: the status, the text, the resource
// titles, and each action label with whether it is offered or only shown as unavailable. Layout, order,
// markup, action numbers and surface notices (such as the terminal's "finish this in the Web client")
// are dropped, and resources and actions are compared as sets.
type Meaning = {
  status: string
  text: string
  resources: string[]
  actions: Record<string, 'offered' | 'unavailable'>
}
/** A surface's meaning and everything it outputs, serialized for the leak check. */
type Collected = { meaning: Meaning; output: string }

/** The meaning of the default text format's lines, given the labels the surface offers. */
function fromLines(lines: readonly string[], offered: readonly string[]): Meaning {
  const [status = '', ...rest] = lines
  const text: string[] = []
  const resources: string[] = []
  const actions: Meaning['actions'] = {}
  let section = ''
  for (const line of rest) {
    if (line === 'Resources:' || line === 'Actions:') section = line
    else if (section === 'Resources:') resources.push(line.replace(/^- /, ''))
    // `Label: why`, or a bare label a chat without buttons shows as text.
    else if (section === 'Actions:') actions[line.split(': ')[0] ?? ''] = 'unavailable'
    else text.push(line)
  }
  for (const label of offered) actions[label] = 'offered'
  return {
    status: status.replace(/^Status: /, ''),
    text: text.join('\n'),
    resources: resources.sort(),
    actions,
  }
}

function sdk(shown: DomainView): Collected & { complete: boolean } {
  const outcome = formatDomainView(shown, { locale: 'en', capabilities: capabilities('sdk') })
  if (!outcome.ok) throw new Error(outcome.error.message)
  const { parts, complete } = outcome.value
  const lines = parts.flatMap((part) => (part.kind === 'text' ? part.text.split('\n') : []))
  const offered = parts.flatMap((part) => (part.kind === 'action' ? [part.label] : []))
  return { meaning: fromLines(lines, offered), output: JSON.stringify(outcome.value), complete }
}

function tui(shown: DomainView): Collected {
  const presented = createDomainConsumer({ locale: 'en', capabilities: capabilities('tui') }).present(shown)
  const needsWeb = t('runtime.view.needsWeb', 'en')
  const [missing = ''] = t('runtime.view.missingFeatures', 'en', { features: '\n' }).split('\n')
  const [before = '', after = ''] = t('runtime.view.actionUnavailable', 'en', { label: '\n' }).split('\n')
  const lines: string[] = []
  const offered: string[] = []
  for (const line of presented.lines) {
    if (line === needsWeb || line.startsWith(missing)) continue
    const numbered = /^\[\d+\] (.*)$/.exec(line)
    if (numbered) offered.push(numbered[1] ?? '')
    else if (line.startsWith(before) && line.endsWith(after))
      lines.push(line.slice(before.length, line.length - after.length))
    else lines.push(line)
  }
  return { meaning: fromLines(lines, offered), output: JSON.stringify(presented) }
}

function im(shown: DomainView): Collected {
  const outcome = toChannelMessages({
    view: shown,
    interaction: null,
    destination: { channelId: 'chat-1', accountId: 'bot-1', conversationId: 'room-1', threadId: null },
    channel: { kind: 'test-chat', maxTextBytes: 4096, supportsButtons: true },
    context: { locale: 'en', capabilities: capabilities('im') },
    renderer: { format: formatDomainView, encode: encodeForChannel },
  })
  if (!outcome.ok) throw new Error(outcome.error.message)
  const parts = outcome.value.messages.flatMap((message) => message.content.parts)
  const lines = parts.flatMap((part) => (part.kind === 'text' ? part.text.split('\n') : []))
  const offered = parts.flatMap((part) => (part.kind === 'action' ? [part.label] : []))
  return { meaning: fromLines(lines, offered), output: JSON.stringify(outcome.value) }
}

async function web(shown: DomainView): Promise<Collected> {
  const presenter = createRendererPresenter({
    target: 'web',
    clientInstanceId: 'client-1',
    capabilities: capabilities('web'),
    locale: 'en',
    // Nothing is clicked, so only the locale is read.
    services: {
      locale: { locale: 'en', text: (key: string) => key, formatNumber: () => '', formatDate: () => '' },
    } as unknown as Parameters<typeof createRendererPresenter>[0]['services'],
    views: { current: (viewId) => (viewId === shown.viewId ? shown : undefined) },
  })
  const presented = presenter.generic().present(shown)
  if (!presented.ok || presented.value.target !== 'web') throw new Error('the view has no Web element')
  const container = document.body.appendChild(document.createElement('div'))
  const root = createAntdRoot(container)
  root.render(presented.value.element)
  const card = await vi.waitFor(() => {
    const found = container.querySelector('.generic-domain-view')
    if (found === null) throw new Error('the card has not rendered')
    return found
  })
  const read = (selector: string) => card.querySelector(selector)?.textContent ?? ''
  const meaning: Meaning = {
    status: read('.state-light-value'),
    text: read('.generic-domain-text'),
    resources: Array.from(
      card.querySelectorAll('.generic-domain-resources li'),
      (item) => item.textContent ?? '',
    ).sort(),
    actions: Object.fromEntries(
      Array.from(card.querySelectorAll('.generic-domain-action button'), (button) => [
        button.textContent ?? '',
        (button as HTMLButtonElement).disabled ? 'unavailable' : 'offered',
      ]),
    ),
  }
  // Text and every attribute the card renders.
  const output = container.innerHTML
  root.unmount()
  container.remove()
  return { meaning, output }
}

// Surfaces differ only in which offered actions they can carry out. The SDK format offers every action the
// view offers this client: enabled, with every required feature negotiated. The Web card carries out
// command actions only. The terminal carries out interactions, downloads and forms, but no commands. A chat
// channel offers buttons only for a view it can present completely; otherwise it sends a read-only
// summary and the user answers in the Web form. An action a surface cannot carry out is shown there as
// unavailable, so each surface must show the SDK's meaning with those actions moved to unavailable.
const carries = (surface: Surface, kind: ViewAction['kind'] | undefined, complete: boolean) =>
  surface === 'web' ? kind === 'command' : surface === 'tui' ? kind !== 'command' : complete

describe('one domain view on every client surface', () => {
  it.each(VIEWS)('%s means the same everywhere and shows no secret', async (_, shown) => {
    expect(validateRuntime('DomainView', shown).ok).toBe(true)
    const reference = sdk(shown)
    const surfaces: [Surface, Collected][] = [
      ['web', await web(shown)],
      ['tui', tui(shown)],
      ['im', im(shown)],
    ]
    const kind = (label: string) => shown.actions.find((entry) => entry.label === label)?.kind
    for (const [surface, { meaning }] of surfaces) {
      const actions = Object.fromEntries(
        Object.entries(reference.meaning.actions).map(([label, state]) => [
          label,
          state === 'offered' && !carries(surface, kind(label), reference.complete) ? 'unavailable' : state,
        ]),
      )
      // Soft, so one run names every surface that differs.
      expect.soft({ surface, ...meaning }).toEqual({ surface, ...reference.meaning, actions })
    }

    const leaks = Object.fromEntries(
      [['sdk', reference] as const, ...surfaces].map(([surface, { output }]) => [
        surface,
        SECRETS.filter((secret) => output.includes(secret)),
      ]),
    )
    expect(leaks).toEqual({ sdk: [], web: [], tui: [], im: [] })
  })
})
