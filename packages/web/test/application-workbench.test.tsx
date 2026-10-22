/** @vitest-environment happy-dom */
import type { ApplicationState } from '@agnes/protocol'
import {
  applicationIdentity,
  applicationTimelineWork,
  applicationWorkDraft,
  applicationWorkRequest,
  applicationWorkText,
  encodeApplicationWork,
  homeEntries,
  homeNavigation,
  openApplicationWork,
  rememberApplicationWork,
  rememberSessionAgent,
  resolveApplicationWork,
  sessionAgentAttribution,
  sessionApplicationWork,
  type UiExtensionContext,
} from '@agnes/web-client'
import { renderRegion, unmountRegion } from '@agnes/web-ui'
import { flushSync } from 'react-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { WebConversationMessages } from '../src/conversation-message-adapter.js'
import {
  ApplicationAttribution,
  ApplicationComposerContext,
  ApplicationWorkActions,
} from '../src/workbench/application-actions.js'
import { ApplicationEvidence } from '../src/workbench/application-evidence.js'
import { useApplicationPanels } from '../src/workbench/application-panels.js'
import { workbenchApproval } from '../src/workbench/approval-store.js'

const state: ApplicationState = {
  revision: 1,
  status: 'active',
  selection: {
    packageId: 'acme/kit',
    applicationId: 'acme',
    integrity: 'one',
    declarationDigest: 'a'.repeat(64),
    consentDigest: 'b'.repeat(64),
    bindingDigest: 'c'.repeat(64),
  },
  assets: {},
  candidates: [],
  effective: {
    id: 'acme',
    defaultAgent: 'acme/kit#review',
    agents: ['acme/kit#review'],
    workbench: {
      tabs: [
        {
          id: 'object',
          title: { en: 'Object' },
          order: -30,
          slot: 'workbench.panel',
          view: 'page',
          page: 'acme/kit#dossier',
          when: 'object',
        },
        { id: 'sign', title: { en: 'Signatures' }, order: -20, slot: 'workbench.panel', view: 'signatures' },
        { id: 'evidence', title: { en: 'Evidence' }, order: -10, slot: 'workbench.panel', view: 'evidence' },
      ],
      actions: [
        {
          id: 'review',
          title: { en: 'Review NCR' },
          prompt: { en: 'Review the evidence' },
          focusTab: 'object',
        },
      ],
    },
  },
}
function Panels({ context }: { context: UiExtensionContext }) {
  const panels = useApplicationPanels(context)
  return (
    <>
      {panels.map((panel) => (
        <section key={panel.id} data-panel={panel.id}>
          <h2>{panel.title?.(context)}</h2>
          <panel.component context={context} />
        </section>
      ))}
    </>
  )
}
afterEach(() => {
  unmountRegion(document.body)
  applicationIdentity.set(undefined)
  workbenchApproval.set(undefined)
  homeNavigation.close()
  sessionStorage.clear()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})
it.each(['paths', 'files'])('opens report files from the %s receipt field', async (field) => {
  document.documentElement.lang = 'en'
  const openPanel = vi.fn()
  const node = {
    kind: 'tool',
    id: 'report',
    name: 'community_report',
    seq: 3,
    resultSeq: 5,
    status: 'completed',
  }
  const context: UiExtensionContext = {
    t: (key) => key,
    openPanel,
    data: {
      timeline: { nodes: [node] },
      session: {
        readToolDetail: async () => ({
          result: {
            structured: {
              data: { title: 'Reviewed report', [field]: ['output/report.html', 'output/report.md', 42] },
            },
          },
        }),
      },
    },
  }
  renderRegion(document.body, <ApplicationEvidence context={context} />)
  await vi.waitFor(() => expect(document.body.textContent).toContain('HTML report'))
  const reports = [...document.querySelectorAll<HTMLButtonElement>('button')]
  expect(document.body.textContent).toContain('Reviewed report')
  expect(document.body.textContent).toContain('Markdown report')
  flushSync(() => reports.find((button) => button.textContent === 'HTML report')!.click())
  expect(openPanel).toHaveBeenCalledWith('files', { path: 'output/report.html' })
})
it('mounts only adopted owner-qualified pages, restores object context, and removes tabs on revoke/clear', () => {
  document.documentElement.lang = 'en'
  applicationIdentity.set(state)
  const request = applicationWorkRequest('review', { type: 'ncr', id: 'NCR-018' })
  rememberApplicationWork('session-one', request, 'acme/kit#review', { en: 'NCR Reviewer' })
  const context: UiExtensionContext = { t: (key) => key, data: { session: { id: 'session-one' } } }
  const page = {
    id: 'dossier',
    order: 0,
    titleKey: 'Dossier',
    icon: 'file',
    component: ({ context }: { context: UiExtensionContext }) => (
      <p>{(context.selection as { object: { id: string } }).object.id}</p>
    ),
  }
  let off = homeEntries.registerOwned('wrong/owner', page)
  try {
    renderRegion(document.body, <Panels context={context} />)
    expect(document.querySelector('[data-panel="application.object"]')).toBeNull()
    flushSync(() => {
      off()
      off = homeEntries.registerOwned('acme/kit', page)
    })
    expect(document.querySelector('[data-panel="application.object"]')?.textContent).toContain('NCR-018')
    flushSync(() => off())
    expect(document.querySelector('[data-panel="application.object"]')).toBeNull()
    flushSync(() =>
      applicationIdentity.set({ ...state, status: 'unresolved', effective: null, reason: 'bad-bundle' }),
    )
    expect(document.querySelector('[data-panel]')).toBeNull()
    flushSync(() => applicationIdentity.set(state))
    expect(document.querySelector('[data-panel="application.sign"]')).not.toBeNull()
    flushSync(() => applicationIdentity.set(undefined))
    expect(document.querySelector('[data-panel]')).toBeNull()
  } finally {
    off()
  }
})
it('renders work chips, routes object links to reviewed launch intent and attributes only the returned session', () => {
  applicationIdentity.set(state)
  renderRegion(document.body, <ApplicationWorkActions />)
  flushSync(() => document.querySelector<HTMLButtonElement>('button')!.click())
  expect(homeNavigation.getSnapshot()).toEqual({
    id: 'agents',
    selection: { workAction: { applicationId: 'acme', packageId: 'acme/kit', actionId: 'review' } },
  })
  openApplicationWork('review', { type: 'ncr', id: 'NCR-018' })
  const request = applicationWorkRequest('review', { type: 'ncr', id: 'NCR-018' })
  expect(resolveApplicationWork(request, 'en')).toMatchObject({
    agent: 'acme/kit#review',
    focusTab: 'object',
  })
  expect(resolveApplicationWork({ ...request, packageId: 'other/kit' }, 'en')).toBeUndefined()
  const resolved = resolveApplicationWork(request, 'en')!
  expect(resolved.prompt).toBe('Review the evidence')
  const encoded = encodeApplicationWork('My edited request', resolved.request)
  expect(applicationWorkText(encoded)).toEqual({ text: 'My edited request', request })
  expect(applicationWorkText('Ordinary JSON\n\n{"object":{"id":"NCR-018"}}').request).toBeUndefined()
  expect(applicationWorkText(encoded.replace('"ncr"', '"invalid type"')).request).toBeUndefined()
  const submitted = { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: encoded }] }
  sessionStorage.clear()
  expect(applicationTimelineWork({ nodes: [submitted] } as never)).toEqual(request)
  expect(
    applicationTimelineWork({
      nodes: [{ ...submitted, content: [{ type: 'text', text: encoded.replace('NCR-018', 'NCR-019') }] }],
    } as never)?.object?.id,
  ).toBe('NCR-019')
  rememberApplicationWork('returned-session', request, resolved.agent, { en: 'NCR Reviewer' })
  renderRegion(document.body, <ApplicationComposerContext sessionId="returned-session" />)
  expect(document.body.textContent).toContain('NCR-018 · Review NCR')
  expect(document.body.textContent).not.toContain('applicationId')
  expect(applicationWorkDraft.read('other-session')).toBeUndefined()
  flushSync(() => document.querySelector<HTMLButtonElement>('[aria-label^="Remove context"]')!.click())
  expect(document.querySelector('[data-testid="application-work-chip"]')).toBeNull()
  expect(applicationWorkDraft.read('returned-session')).toBeUndefined()
  expect(sessionApplicationWork('returned-session')?.request).toEqual(request)
  expect(encodeApplicationWork('Plain request', applicationWorkDraft.read('returned-session'))).toBe(
    'Plain request',
  )
  // The conversation reads the session's readiness to gate a failed turn's retry; this fixture is
  // already admitted, so the snapshot is one stable ready value.
  const readinessSnapshot = { status: 'ready', epoch: 0, sessionId: 'returned-session' }
  const session = {
    subscribe: () => () => {},
    getSnapshot: () => 'returned-session',
    readiness: { subscribe: () => () => {}, getSnapshot: () => readinessSnapshot },
  }
  renderRegion(document.body, <ApplicationAttribution session={session as never} />)
  expect(document.body.textContent).toContain('Handled by NCR Reviewer')
  renderRegion(
    document.body,
    <WebConversationMessages
      session={session as never}
      nodes={[submitted as never, { kind: 'assistant', id: 'answer', seq: 2, text: 'Evidence reviewed' }]}
      turns={[
        {
          id: 'turn',
          status: 'completed',
          nodeIds: ['u1', 'answer'],
          finalAssistantId: 'answer',
          startedAt: '2026-10-20T00:00:00Z',
          endedAt: '2026-10-20T00:00:01Z',
          turn: 1,
          startSeq: 1,
          inherited: false,
          forkable: false,
          usage: {
            totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
            reasoningComplete: true,
            billingComplete: true,
            calls: [],
          },
        },
      ]}
    />,
  )
  expect(document.body.textContent).toContain('My edited request')
  expect(document.body.textContent).toContain('NCR-018 · Review NCR')
  expect(document.body.textContent).not.toContain('applicationId')
  expect(
    document.querySelector('.process-identity [data-testid="application-attribution"]')?.textContent,
  ).toContain('Handled by NCR Reviewer')
  expect(submitted.content[0]!.text).toBe(encoded)
  const storageFailure = vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
    throw new Error('Storage unavailable')
  })
  rememberApplicationWork('memory-only', request, resolved.agent, { en: 'NCR Reviewer' })
  expect(applicationWorkDraft.read('memory-only')).toEqual(request)
  applicationWorkDraft.remove('memory-only')
  expect(applicationWorkDraft.read('memory-only')).toBeUndefined()
  storageFailure.mockRestore()

  renderRegion(
    document.body,
    <ApplicationAttribution session={{ ...session, getSnapshot: () => 'other-session' } as never} />,
  )
  expect(document.body.textContent).toBe('')
  rememberSessionAgent('default-session', resolved.agent, { en: 'Default reviewer' })
  const { agents: _agents, ...withoutCatalogue } = state.effective!
  flushSync(() => applicationIdentity.set({ ...state, effective: withoutCatalogue }))
  expect(sessionAgentAttribution('default-session')).toBe('Default reviewer')
  flushSync(() => applicationIdentity.set(undefined))
  expect(sessionAgentAttribution('default-session')).toBeUndefined()
  expect(() => openApplicationWork('review')).toThrow('unavailable')
})
it('shows pending status and jumps to the sole conversation decision without duplicating actions', () => {
  applicationIdentity.set(state)
  const confirm = vi.fn()
  workbenchApproval.set({
    key: 'decision:1',
    title: 'Human signature',
    summary: 'NCR-018 · revision 2',
    impact: 'Hardware stays on hold',
    actions: [{ id: 'durable:allowed-once', label: 'Sign', onSelect: confirm }],
    disabled: false,
  })
  renderRegion(document.body, <Panels context={{ t: (key) => key, data: { session: { id: 'one' } } }} />)
  expect(document.querySelector('[data-approval-action]')).toBeNull()
  expect(document.body.textContent).toContain('Awaiting confirmation in conversation')
  const card = document.createElement('div')
  card.id = 'approval-content'
  card.innerHTML =
    '<div data-approval-key="decision:1"><button data-approval-action="allow">Sign</button></div>'
  document.body.append(card)
  flushSync(() =>
    [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Go to confirmation')!
      .click(),
  )
  expect(document.activeElement).toBe(card.querySelector('button'))
  expect(confirm).not.toHaveBeenCalled()
  card.remove()
  flushSync(() => workbenchApproval.set(undefined))
  expect(document.querySelector('[data-approval-action]')).toBeNull()
  expect(document.body.textContent).toContain('No signatures pending')
})

it('lists declared evidence objects with localized states, keeps executions in details and ignores unrelated results', async () => {
  document.documentElement.lang = 'zh-CN'
  const openPanel = vi.fn()
  const outputs = [
    {
      evidence: [
        { name: '审阅记录', kind: 'record', status: 'available', path: 'review.md' },
        { name: '待出报告', kind: 'report', status: 'pending', path: 'report.html' },
        { name: '失败报告', kind: 'report', status: 'failed', path: 'bad.html' },
        { name: 'bad', kind: 'file', status: 'available', path: 'javascript:alert(1)' },
      ],
    },
    { data: { count: 20 } },
  ]
  renderRegion(
    document.body,
    <ApplicationEvidence
      context={{
        t: (key) => key,
        openPanel,
        data: {
          timeline: {
            nodes: outputs.map((_, i) => ({
              kind: 'tool',
              id: String(i),
              name: 'plain_test',
              seq: i + 1,
              resultSeq: i + 3,
              status: 'completed',
            })),
          },
          session: {
            id: 'test',
            readToolDetail: async (seq: number) => ({ result: { structured: outputs[seq - 1] } }),
          },
        },
      }}
    />,
  )
  await vi.waitFor(() => expect(document.querySelectorAll('article')).toHaveLength(3))
  expect(document.body.textContent).toContain('可查看')
  expect(document.body.textContent).toContain('待完成')
  expect(document.body.textContent).toContain('不可用')
  expect(document.querySelector('h3')?.textContent).toBe('审阅记录')
  expect(document.querySelector('code')?.closest('[data-open]')?.getAttribute('data-open')).toBe('false')
  const open = document.querySelector<HTMLButtonElement>('article button')!
  flushSync(() => open.click())
  expect(openPanel).toHaveBeenCalledWith('files', { path: 'review.md' })
  expect(document.querySelectorAll('button:disabled')).toHaveLength(2)
})
