import type { ClientProfileCaller, ModuleIdentity } from '@agnes/web-client'
import { revokeContributionOwner, settingsSections } from '@agnes/web-client'
import { createClientPanelTestHost, React } from '@agnes/web-client/testkit'
import { fireEvent, getByRole, queryByRole } from '@testing-library/dom'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import * as judgment from '../src/index.js'

const identity: ModuleIdentity = {
  packageId: '@agnes/judgment',
  rowId: 'ext:agnes.judgment/main',
  revision: 'fixture-one',
  services: ['judgment.status'],
  binding: {
    owner: 'ext:agnes.judgment/main',
    lifetime: 'profile',
    availability: 'active',
    packageId: '@agnes/judgment',
    integrity: 'sha256-fixture',
    profileId: 'fixture',
    activationId: 'fixture-one',
  },
}
const disabled = { enabled: false, available: false, reason: 'disabled', requests: 0 }
const status = {
  version: 1,
  configurationRevision: 'b'.repeat(64),
  state: 'ready',
  reason: 'none',
  hookTimeout: 'unknown',
  cache: { hit: 7, miss: 9, size: 2 },
  uses: {
    stop: disabled,
    rules: disabled,
    findRelevant: { enabled: true, available: false, reason: 'native-required', requests: 3 },
    judgeBatch: { enabled: true, available: true, reason: 'none', requests: 4 },
  },
}

async function page(caller: ClientProfileCaller, locale: 'en' | 'zh-CN' = 'en', moduleIdentity = identity) {
  const host = await createClientPanelTestHost(judgment, moduleIdentity, caller, locale)
  const element = host.window.document.createElement('div')
  host.container.append(element)
  const container = element as unknown as HTMLDivElement
  const root = createRoot(container)
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const name of ['location', 'history'] as const) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { value: host.window[name], configurable: true })
  }
  return {
    ...host,
    container,
    async render() {
      const entry = settingsSections.get('judgment')
      expect(entry, 'judgment settings must register through the public registry').toBeDefined()
      if (!entry) return
      await host.act(async () =>
        root.render(React.createElement(entry.component, { context: { t: (key) => key } })),
      )
    },
    async dispose() {
      await host.act(async () => root.unmount())
      await host.dispose()
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    },
  }
}

it('renders loading, bounded instance statistics and native-only availability without a session', async () => {
  let finish!: (value: unknown) => void
  const pending = new Promise((resolve) => {
    finish = resolve
  })
  const host = await page(async (_module, name, input, options) => {
    expect(name).toBe('judgment.status')
    expect(input).toEqual({})
    expect(options).toBeUndefined()
    return { output: await pending }
  }, 'zh-CN')
  try {
    await host.render()
    expect(getByRole(host.container, 'status').textContent).toContain('正在读取')
    await host.act(async () => finish(status))
    expect(getByRole(host.container, 'heading', { name: '判断' })).toBeDefined()
    expect(host.container.textContent).toContain('命中: 7')
    expect(host.container.textContent).toContain('未命中: 9')
    expect(host.container.textContent).toContain('条目: 2')
    expect(host.container.textContent).toContain('需要原生判断模型')
    expect(host.container.textContent).toContain('新会话')
    expect(host.container.textContent).toContain('钩子授权时限：未知')
    expect(host.container.textContent).toContain('当前实例配置指纹')
    expect(getByRole(host.container, 'link', { name: '打开插件设置' }).getAttribute('href')).toBe(
      '?page=plugins&tab=plugins&view=plugin%3A%40agnes%2Fjudgment',
    )
  } finally {
    await host.dispose()
  }
  expect(settingsSections.get('judgment')).toBeUndefined()
})

it('refreshes and clears previous statistics on service refusal or malformed responses', async () => {
  let response: unknown = status
  let refuse = false
  const host = await page(async () => {
    if (refuse) throw new Error('private endpoint and credential')
    return { output: response }
  })
  try {
    await host.render()
    expect(host.container.textContent).toContain('Hits: 7')
    refuse = true
    await host.act(async () => fireEvent.click(getByRole(host.container, 'button', { name: 'Refresh' })))
    expect(getByRole(host.container, 'alert').textContent).toContain('unavailable')
    expect(host.container.textContent).not.toContain('Hits: 7')
    expect(host.container.textContent).not.toContain('private endpoint')
    refuse = false
    response = { ...status, input: 'private content' }
    await host.act(async () => fireEvent.click(getByRole(host.container, 'button', { name: 'Refresh' })))
    expect(getByRole(host.container, 'alert').textContent).toContain('unavailable')
    expect(host.container.textContent).not.toContain('private content')
    response = { ...status, cache: { hit: 8, miss: 10, size: 3 } }
    await host.act(async () => fireEvent.click(getByRole(host.container, 'button', { name: 'Refresh' })))
    expect(host.container.textContent).toContain('Hits: 8')
    expect(queryByRole(host.container, 'alert')).toBeNull()
  } finally {
    await host.dispose()
  }
})

it('withdraws its settings registration and ignores an in-flight result after revocation', async () => {
  let finish!: (value: unknown) => void
  let pending = false
  const host = await page(async () => ({
    output: pending
      ? await new Promise((resolve) => {
          finish = resolve
        })
      : status,
  }))
  try {
    await host.render()
    expect(host.container.textContent).toContain('Hits: 7')
    pending = true
    await host.act(async () => fireEvent.click(getByRole(host.container, 'button', { name: 'Refresh' })))
    await host.act(async () => revokeContributionOwner('ext:agnes.judgment/main'))
    expect(settingsSections.get('judgment')).toBeUndefined()
    expect(getByRole(host.container, 'alert').textContent).toContain('unavailable')
    expect(getByRole(host.container, 'button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(true)
    await host.act(async () => finish(status))
    expect(host.container.textContent).not.toContain('Hits: 7')
  } finally {
    await host.dispose()
  }
})

it('shows unavailable when the installed descriptor lacks its exact service allowlist', async () => {
  let dispatched = 0
  const host = await page(
    async () => {
      dispatched += 1
      return { output: status }
    },
    'en',
    { ...identity, services: [] },
  )
  try {
    await host.render()
    expect(getByRole(host.container, 'alert').textContent).toContain('unavailable')
    expect(host.container.textContent).not.toContain('Hits: 7')
    expect(dispatched).toBe(0)
  } finally {
    await host.dispose()
  }
})
