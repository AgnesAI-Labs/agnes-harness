/** @vitest-environment happy-dom */
import {
  clearResources,
  installFeedbackSink,
  type OperationFeedback,
  PushStack,
  searchParamRoute,
} from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { TriggersPanel } from '../src/settings/triggers.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let release: (() => void) | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  release?.()
  clearResources()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.body.replaceChildren()
  history.replaceState(null, '', '/')
})

it.each(['current', 'late-saved', 'late-failed', 'reserved-id', 'legacy-link'] as const)(
  'names configure/save/delete outcomes and ignores stale form results (%s)',
  async (race) => {
    let finish!: (response: Response) => void
    const outcomes: OperationFeedback[] = []
    release = installFeedbackSink({ publish: (result) => outcomes.push(result), resolve() {} })
    const rule = {
      id: race === 'reserved-id' ? 'new' : 'preview',
      enabled: true,
      provider: 'github',
      auth: 'hmac',
      secretRef: 'secret://preview/event',
      event: 'issues',
      filters: {},
      workspace: '/preview',
      agent: 'read-only',
      bundles: [],
      template: '{{$.issue.title}}',
      timestampPath: '$.updated_at',
      windowSeconds: 300,
      ratePerMinute: 10,
    }
    let snapshot = {
      config: { enabled: false, path: '/hooks/events', maxPayloadBytes: 1024 },
      rules: [rule],
      deliveries: [],
      secretRefs: [],
    }
    let deliveryStatus = 'pending'
    const samples: { issue: { updated_at: string } }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/context')
          return Response.json({
            config: {
              rulesEnabled: true,
              timeEnabled: true,
              timeZone: 'UTC',
              refreshIntervalMs: 1000,
              maxBytes: 1000,
              maxSourceBytes: 1000,
              customSkillRoots: [],
              instructionFiles: [],
              localInstructionFiles: [],
            },
            workspaces: [{ path: '/preview', available: true }],
          })
        if (url !== '/api/triggers') return Response.json({ items: [] })
        const input = JSON.parse(String(init?.body))
        if (input.action === 'test') samples.push(input.payload)
        if (input.action === 'upsert') {
          expect(input.rule.unattendedApproval).toBe('refuse')
          if (race !== 'current')
            return new Promise<Response>((resolve) => {
              finish = resolve
            })
        }
        if (input.action === 'configure') snapshot = { ...snapshot, config: input.config }
        if (input.action === 'delete') snapshot = { ...snapshot, rules: [] }
        return Response.json({
          snapshot,
          ...(input.action === 'test' ? { delivery: { status: deliveryStatus } } : {}),
        })
      }),
    )
    const host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    await act(async () =>
      root?.render(
        createElement(
          PushStack,
          {
            rootTitle: 'Automation',
            ...(['reserved-id', 'legacy-link'].includes(race) ? { route: searchParamRoute('view') } : {}),
          },
          createElement(TriggersPanel, { canSave: true }),
        ),
      ),
    )
    const click = async (selector: string) =>
      act(async () => document.querySelector<HTMLElement>(selector)?.click())
    await click('[data-testid="triggers-configure"]')
    expect(outcomes.at(-1)).toMatchObject({ outcome: 'success', message: 'Endpoint settings saved.' })
    await click(`[data-testid="trigger-edit-${rule.id}"]`)
    if (race === 'reserved-id' || race === 'legacy-link') {
      expect(new URL(location.href).searchParams.get('view')).not.toBe('trigger-new')
      await act(async () => root?.unmount())
      clearResources()
      if (race === 'legacy-link') history.replaceState(null, '', '/?view=trigger-preview')
      root = createRoot(host)
      await act(async () =>
        root?.render(
          createElement(
            PushStack,
            { rootTitle: 'Automation', route: searchParamRoute('view') },
            createElement(TriggersPanel, { canSave: true }),
          ),
        ),
      )
      const id = document.querySelector<HTMLInputElement>('[data-testid="trigger-id"]')
      expect(id?.value).toBe(rule.id)
      expect(id?.disabled).toBe(true)
      if (race === 'legacy-link') {
        const approval = document.querySelector<HTMLSelectElement>(
          '[data-testid="trigger-approval-behavior"]',
        )
        if (!approval) throw new Error('missing approval behavior')
        await act(async () => {
          approval.value = 'refuse'
          approval.dispatchEvent(new Event('change', { bubbles: true }))
        })
        await click('[data-testid="trigger-test-details"] .agh-disclosure-summary')
        await click('[data-testid="trigger-test"]')
        expect(approval.value).toBe('refuse')
      }
      return
    }
    await act(async () => {
      const approval = document.querySelector<HTMLSelectElement>('[data-testid="trigger-approval-behavior"]')
      if (!approval) throw new Error('missing trigger approval behavior')
      expect(approval.value).toBe('notify')
      approval.value = 'refuse'
      approval.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () =>
      document
        .querySelector('form#trigger-editor')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    )
    if (race !== 'current') {
      expect(finish).toBeTypeOf('function')
      await act(async () => {
        history.replaceState({ agnesPushPage: 0 }, '')
        window.dispatchEvent(new PopStateEvent('popstate', { state: { agnesPushPage: 0 } }))
      })
      expect(document.querySelector('form#trigger-editor')).toBeNull()
      await click('[data-testid="trigger-edit-preview"]')
      const before = outcomes.length
      await act(async () =>
        finish(race === 'late-failed' ? Response.json({}, { status: 500 }) : Response.json({ snapshot })),
      )
      expect(document.querySelector('form#trigger-editor')).not.toBeNull()
      expect(document.querySelector('[data-testid="triggers-error"]')).toBeNull()
      expect(outcomes).toHaveLength(before)
      return
    }
    expect(outcomes.at(-1)?.message).toBe('Trigger saved.')
    await click('[data-testid="trigger-edit-preview"]')
    const count = outcomes.length
    await click('[data-testid="trigger-test-details"] .agh-disclosure-summary')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 301_000)
    for (const status of ['accepted', 'bad-signature', 'pending', 'unknown', 'replay']) {
      deliveryStatus = status
      await click('[data-testid="trigger-test"]')
      expect(outcomes).toHaveLength(count)
      const notice = host.querySelector('[data-testid="triggers-notice"]')
      expect(notice?.getAttribute('data-tone')).toBe(
        ['bad-signature', 'replay'].includes(status) ? 'error' : 'info',
      )
      expect(notice?.closest('[hidden]')).toBeNull()
      expect(notice?.closest('[data-testid="trigger-test-details"]')).not.toBeNull()
      expect(samples.at(-1)?.issue.updated_at).toBe(new Date().toISOString())
    }
    const custom = { issue: { updated_at: '2020-01-01T00:00:00Z' } }
    await act(async () => {
      const sample = document.querySelector<HTMLTextAreaElement>('[data-testid="trigger-sample"]')
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      if (!sample || !set) throw new Error('missing sample editor')
      set.call(sample, JSON.stringify(custom))
      sample.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('[data-testid="trigger-test"]')
    expect(samples.at(-1)).toEqual(custom)
    // The list action still owns delete; it is not a generic save.
    await click('[data-testid="push-back"]')
    await click('[data-testid="trigger-delete-preview"]')
    const remove = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
      item.textContent?.includes('Delete'),
    )
    await act(async () => remove?.click())
    await click('[data-testid="trigger-remove-confirm"]')
    expect(outcomes.at(-1)?.message).toBe('Trigger deleted.')
  },
)
