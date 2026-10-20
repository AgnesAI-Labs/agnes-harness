/** @vitest-environment happy-dom */
import type { ApplicationState } from '@agnes/protocol'
import {
  applicationIdentity,
  applicationTimelineWork,
  applicationWorkRequest,
  homeEntries,
  homeNavigation,
  openApplicationWork,
  rememberApplicationWork,
  rememberSessionAgent,
  resolveApplicationWork,
  sessionAgentAttribution,
  type UiExtensionContext,
} from '@agnes/web-client'
import { renderRegion, unmountRegion } from '@agnes/web-ui'
import { flushSync } from 'react-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { ApplicationAttribution, ApplicationWorkActions } from '../src/workbench/application-actions.js'
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
  expect(JSON.parse(resolved.prompt.split('\n\n').at(-1)!)).toEqual({
    applicationId: 'acme',
    packageId: 'acme/kit',
    actionId: 'review',
    object: { type: 'ncr', id: 'NCR-018' },
  })
  const submitted = { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: resolved.prompt }] }
  expect(applicationTimelineWork({ nodes: [submitted] } as never)).toEqual(request)
  expect(
    applicationTimelineWork({
      nodes: [
        { ...submitted, content: [{ type: 'text', text: resolved.prompt.replace('NCR-018', 'NCR-019') }] },
      ],
    } as never)?.object?.id,
  ).toBe('NCR-019')
  rememberApplicationWork('returned-session', request, resolved.agent, { en: 'NCR Reviewer' })
  const session = { subscribe: () => () => {}, getSnapshot: () => 'returned-session' }
  renderRegion(document.body, <ApplicationAttribution session={session as never} />)
  expect(document.body.textContent).toContain('Handled by NCR Reviewer')
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
it('uses the same host decision actions in place and retires them when the host clears the request', () => {
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
  flushSync(() => document.querySelector<HTMLButtonElement>('[data-approval-action]')!.click())
  expect(confirm).toHaveBeenCalledOnce()
  flushSync(() => workbenchApproval.set(undefined))
  expect(document.querySelector('[data-approval-action]')).toBeNull()
  expect(document.body.textContent).toContain('No signatures pending')
})
