/** @vitest-environment happy-dom */

import { CredentialsApi } from '@agnes/resource-control-web/credentials-api'
import { getByRole } from '@testing-library/dom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ChannelDialogHost } from '../src/pages/channel-dialog.js'
import { closeChannelDialog } from '../src/pages/channel-dialog-state.js'
import { ChannelsPanel } from '../src/pages/channels.js'
import type { HomePageData } from '../src/pages/host.js'

it('previews instances, folds groups without losing open details, and expands all connections on demand', async () => {
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const language = document.documentElement.lang
  document.documentElement.lang = 'en'
  const channels = ['DingTalk', 'Feishu', 'WeChat'].map((name, group) => ({
    provider: {
      extension: `plugin/${name}`,
      manifest: { id: name.toLowerCase(), displayName: name },
      bindingAvailable: true,
    },
    instances: Array.from({ length: 5 }, (_, i) => ({
      id: `connection-${group}-${i}`,
      workspace: 'D:/work',
      agent: 'default',
      version: 1,
      connection: { channel: 'connected', daemon: 'connected' },
      unavailable: false,
      bindings: [
        {
          sessionId: `session-${group}-${i}`,
          sessionTitle: `Session ${group}-${i}`,
          targetId: `peer-${i}`,
          label: `Team ${i}`,
          state: 'active',
        },
      ],
    })),
  }))
  const data = {
    call: vi.fn(async () => ({ channels, sessions: [] })),
    sessionId: () => undefined,
  } as unknown as HomePageData
  try {
    await act(async () => root.render(createElement(ChannelsPanel, { data })))
    await vi.waitFor(() => expect(host.querySelectorAll('.channel-group-shell')).toHaveLength(3))
    const first = host.querySelector<HTMLElement>('.channel-group-shell')!
    const rows = () => first.querySelectorAll('.channel-connection:not([hidden])')
    expect(rows()).toHaveLength(3)
    await act(async () => getByRole(first, 'button', { name: 'Show 2 more connections' }).click())
    expect(rows()).toHaveLength(5)
    const details = getByRole(first, 'button', { name: 'Connection details: Session 0-4' })
    await act(async () => details.click())
    expect(details.getAttribute('aria-expanded')).toBe('true')
    await act(async () => getByRole(first, 'button', { name: 'Show fewer connections' }).click())
    expect(rows()).toHaveLength(3)
    await act(async () => getByRole(first, 'button', { name: 'Show 2 more connections' }).click())
    expect(details.getAttribute('aria-expanded')).toBe('true')
    await act(async () => getByRole(host, 'button', { name: 'Collapse all' }).click())
    expect(
      [...host.querySelectorAll('.channel-group > button')].every(
        (button) => button.getAttribute('aria-expanded') === 'false',
      ),
    ).toBe(true)
    await act(async () => getByRole(first, 'button', { name: 'DingTalk connections' }).click())
    expect(details.getAttribute('aria-expanded')).toBe('true')
    await act(async () => getByRole(host, 'button', { name: 'Expand all' }).click())
    expect(host.querySelectorAll('.channel-connection:not([hidden])')).toHaveLength(15)
  } finally {
    await act(async () => root.unmount())
    host.remove()
    document.documentElement.lang = language
  }
})

it('creates a dedicated connection that binds no session and ends when it exists', async () => {
  const credentials = vi.spyOn(CredentialsApi.prototype, 'list').mockResolvedValue([])
  vi.spyOn(CredentialsApi.prototype, 'context').mockRejectedValue(new Error('offline'))
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const language = document.documentElement.lang
  document.documentElement.lang = 'en'
  const provider = {
    extension: 'plugin/feishu',
    bindingAvailable: true,
    configSchema: { type: 'object', properties: {} },
    manifest: { id: 'feishu', displayName: 'Feishu', credentials: { required: [], optional: [] } },
  }
  const existing = {
    id: 's-123456abcdef-123456',
    workspace: 'D:/work',
    agent: 'default',
    credentialRefs: {},
    allowFrom: [],
    requireMention: true,
    version: 1,
    connection: { channel: 'connected', daemon: 'connected' },
    unavailable: false,
    bindings: [
      { sessionId: 'current', sessionTitle: 'Planning', targetId: 'peer', label: 'Team', state: 'active' },
    ],
  }
  let outcome: 'approval-required' | 'completed' | 'conflict' | 'refused' | 'lost' = 'approval-required'
  const call = vi.fn(async (method: string, _params?: unknown) => {
    if (method === 'channels.overview')
      return {
        sessions: [{ sessionId: 'current', title: 'Planning', cwd: 'D:/work' }],
        channels: [{ provider, configurationRevision: 'revision', instances: [existing] }],
      }
    if (method === 'channels.dedicatedContext')
      return {
        instanceId: 'd-0123456789ab',
        agent: 'default',
        agentTitle: { en: 'General assistant', 'zh-CN': '通用助手' },
        workspaces: [{ workspaceId: 'w-team', name: 'Team', path: '/work/team' }],
      }
    if (method === 'channels.configureDedicated' && outcome === 'refused')
      throw Object.assign(new Error('Channel operation was not confirmed'), { code: 'CHANNEL_REFUSED' })
    if (method === 'channels.configureDedicated' && outcome === 'lost') throw new Error('lost response')
    if (method === 'channels.configureDedicated')
      return {
        receipt:
          outcome === 'conflict'
            ? { state: 'refused', operationId: 'op', code: 'REVISION_CONFLICT' }
            : { state: outcome, operationId: 'op' },
        instanceId: 'd-0123456789ab',
      }
    throw new Error(`unexpected ${method}`)
  })
  const requestProfileApproval = vi.fn()
  const data = {
    call,
    requestProfileApproval,
    sessionId: () => 'current',
    openSettings: vi.fn(),
  } as unknown as HomePageData
  const button = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent?.trim() === name,
    )
  const choose = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('.channel-dialog .channel-choice')].find((item) =>
      item.textContent?.includes(name),
    )
  try {
    await act(async () =>
      root.render(
        createElement('div', null, [
          createElement(ChannelsPanel, { key: 'panel', data }),
          createElement(ChannelDialogHost, { key: 'dialog', data }),
        ]),
      ),
    )
    await vi.waitFor(() => expect(button('Add dedicated connection')).toBeTruthy())
    await act(async () => button('Add dedicated connection')!.click())
    await vi.waitFor(() => expect(document.querySelector('.channel-dialog')).toBeTruthy())
    const steps = () => [...document.querySelectorAll('.channel-steps li')].map((item) => item.textContent)
    expect(steps().join(' ')).not.toContain('Session')
    await act(async () => choose('Feishu')!.click())
    await vi.waitFor(() => expect(document.body.textContent).toContain('/work/team'))
    expect(call).toHaveBeenCalledWith('channels.dedicatedContext', { extension: 'plugin/feishu' })
    await act(async () => button('Create connection')!.click())
    expect(requestProfileApproval).toHaveBeenCalledWith({ state: 'approval-required', operationId: 'op' })
    outcome = 'completed'
    await act(async () => button('Continue creating')!.click())
    await vi.waitFor(() => expect(document.body.textContent).toContain('Dedicated connection created'))
    expect(document.body.textContent).toContain('Instance ID: d-0123456789ab')
    const sent = call.mock.calls.filter(([method]) => method === 'channels.configureDedicated')
    expect(sent).toHaveLength(2)
    expect(sent[0]![1]).toEqual(sent[1]![1])
    expect(sent[0]![1]).toEqual({
      extension: 'plugin/feishu',
      workspaceId: 'w-team',
      instanceId: 'd-0123456789ab',
      credentialRefs: {},
      config: {},
      allowFrom: [],
      requireMention: true,
      configurationRevision: 'revision',
      operationId: expect.any(String),
    })
    // The flow ends: no session step, no binding controls, no session or binding call.
    expect(steps().join(' ')).not.toContain('Session')
    expect(document.body.textContent).not.toContain('Bind later')
    expect(
      call.mock.calls.some(([method]) => ['channels.context', 'channels.configure'].includes(method)),
    ).toBe(false)
    await act(async () => button('Done')!.click())
    await vi.waitFor(() => expect(document.querySelector('.channel-dialog')).toBeNull())

    // A configuration changed elsewhere is reported as nothing saved; a retry starts over.
    outcome = 'conflict'
    await act(async () => button('Add dedicated connection')!.click())
    await act(async () => choose('Feishu')!.click())
    await vi.waitFor(() => expect(button('Create connection')).toBeTruthy())
    await act(async () => button('Create connection')!.click())
    await vi.waitFor(() => expect(document.body.textContent).toContain('Nothing was saved'))
    expect(button('Create connection')).toBeTruthy()
    const retried = call.mock.calls.filter(([method]) => method === 'channels.configureDedicated')
    expect(retried).toHaveLength(3)

    // A launcher refusal is shown and leaves the form usable with a fresh read, not stuck retrying.
    outcome = 'refused'
    const reads = () => call.mock.calls.filter(([method]) => method === 'channels.overview').length
    const before = reads()
    await act(async () => button('Create connection')!.click())
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('cannot be created with these settings'),
    )
    expect(button('Create connection')).toBeTruthy()
    expect(reads()).toBeGreaterThan(before)

    // An unconfirmed attempt can be continued, or started over as a new operation after a fresh read.
    outcome = 'lost'
    await act(async () => button('Create connection')!.click())
    await vi.waitFor(() => expect(button('Start over')).toBeTruthy())
    expect(button('Continue creating')).toBeTruthy()
    await act(async () => button('Start over')!.click())
    expect(button('Create connection')).toBeTruthy()
    outcome = 'completed'
    await act(async () => button('Create connection')!.click())
    await vi.waitFor(() => expect(document.body.textContent).toContain('Dedicated connection created'))
    const attempts = call.mock.calls
      .filter(([method]) => method === 'channels.configureDedicated')
      .map(([, params]) => (params as { operationId: string }).operationId)
    expect(attempts.at(-1)).not.toBe(attempts.at(-2))
  } finally {
    await act(async () => {
      closeChannelDialog()
      root.unmount()
    })
    host.remove()
    document.documentElement.lang = language
    credentials.mockRestore()
    vi.restoreAllMocks()
  }
})
