/** @vitest-environment happy-dom */
import { clearResources, installFeedbackSink, type OperationFeedback, PushStack } from '@agnes/web-ui'
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
  document.body.replaceChildren()
})

it('names confirmed configure/save/delete outcomes and keeps pending/unknown delivery results out of success', async () => {
  const outcomes: OperationFeedback[] = []
  release = installFeedbackSink({ publish: (result) => outcomes.push(result), resolve() {} })
  const rule = {
    id: 'preview',
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
      if (input.action === 'upsert') expect(input.rule.unattendedApproval).toBe('refuse')
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
      createElement(PushStack, { rootTitle: 'Automation' }, createElement(TriggersPanel, { canSave: true })),
    ),
  )
  const click = async (selector: string) =>
    act(async () => document.querySelector<HTMLElement>(selector)?.click())
  await click('[data-testid="triggers-configure"]')
  expect(outcomes.at(-1)).toMatchObject({ outcome: 'success', message: 'Endpoint settings saved.' })
  await click('[data-testid="trigger-edit-preview"]')
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
  expect(outcomes.at(-1)?.message).toBe('Trigger saved.')
  await click('[data-testid="trigger-edit-preview"]')
  const count = outcomes.length
  for (const status of ['pending', 'unknown']) {
    deliveryStatus = status
    await click('[data-testid="trigger-test"]')
    expect(outcomes).toHaveLength(count)
    expect(host.querySelector('[data-testid="triggers-notice"]')?.getAttribute('data-tone')).toBe('info')
  }
  // The list action still owns delete; it is not a generic save.
  await click('[data-testid="trigger-delete-preview"]')
  const remove = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
    item.textContent?.includes('Delete'),
  )
  await act(async () => remove?.click())
  await click('[data-testid="trigger-remove-confirm"]')
  expect(outcomes.at(-1)?.message).toBe('Trigger deleted.')
})
