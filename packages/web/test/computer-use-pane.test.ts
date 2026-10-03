/** @vitest-environment happy-dom */
import { Context } from '@agnes/cordis'
import { SlotRegistry } from '@agnes/web-client'
import { createElement, StrictMode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { type AgnesClient, startClientModules } from '../src/client-modules/boot.js'
import { createComputerUsePaneController } from '../src/computer-use-pane.js'
import type { ComputerUseOperationPolling, ComputerUseStatusClient } from '../src/computer-use-state.js'
import { mountSettingsPaneRegion, settingsPaneSlot } from '../src/region-slots.js'

const ready = {
  schemaVersion: 1,
  status: 'ready',
  driver: { platform: 'darwin', version: 'fixture' },
  runtime: { state: 'running', activeSessions: 0 },
}
const required = { status: 'required', probe: { accessibility: false, screenRecording: false } }
const granted = { status: 'granted' }
const running = {
  status: 'found',
  operationId: 'cu-fixture',
  kind: 'install',
  state: 'running',
  phase: 'installing',
}
const cancelled = { ...running, state: 'cancelled', phase: 'complete' }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  document.body.replaceChildren()
})

function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture(
  call: ReturnType<typeof vi.fn>,
  polling: ComputerUseOperationPolling = {},
  strict = false,
) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry)
  const slots = (ctx as unknown as { slots: SlotRegistry }).slots
  const owner = createComputerUsePaneController({ call: call as ComputerUseStatusClient['call'] }, polling)
  const host = document.createElement('div')
  document.body.append(host)
  const region = mountSettingsPaneRegion(slots, host, {
    computerUse: strict ? createElement(StrictMode, null, owner.render()) : owner.render(),
    onChange: ({ pane }) => {
      if (pane === 'computer-use') void owner.refresh()
    },
  })
  cleanups.push(async () => {
    region.dispose()
    owner.dispose()
    await ctx.fiber.dispose()
    host.remove()
  })
  const text = (id: string) => host.querySelector(`#computer-use-${id}`)?.textContent
  const button = (id: string) => {
    const node = host.querySelector<HTMLButtonElement>(`#computer-use-${id}`)
    if (!node) throw new Error(`missing button ${id}`)
    return node
  }
  const settled = () => vi.waitFor(() => expect(button('refresh').disabled).toBe(false))
  const replace = async () => {
    const remove = slots.register(
      { name: settingsPaneSlot('computer-use'), owner: 'fixture', priority: -1 },
      () => createElement('div', { id: 'computer-use-override' }, '替换面板'),
    )
    await vi.waitFor(() => expect(host.querySelector('#computer-use-override')).not.toBeNull())
    return async () => {
      remove()
      await vi.waitFor(() => expect(text('state')).toBe('Running'))
      await vi.waitFor(() => expect(text('permission-state')).toBe('Authorization required'))
      await vi.waitFor(() => expect(button('operation-refresh').disabled).toBe(false))
    }
  }
  return { owner, host, slots, region, text, button, settled, replace }
}

const normal = (method: string) =>
  method.endsWith('operation.status')
    ? { status: 'not-found' }
    : method.endsWith('permissions.status')
      ? required
      : method.endsWith('doctor')
        ? { status: 'ready', admission: { reason: 'macos-verified-driver' } }
        : ready

it('keeps focus and controls through status updates, switching away, replacement and returning', async () => {
  const call = vi.fn(async (method: string) => normal(method))
  const f = await fixture(call)
  await f.settled()
  f.button('management').click()
  await f.settled()
  expect(f.region.pane('computer-use')?.hidden).toBe(false)
  const doctor = f.button('doctor-run')
  doctor.focus()
  doctor.click()
  await vi.waitFor(() => expect(f.text('doctor-state')).toBe('Check passed'))
  expect(f.button('doctor-run')).toBe(doctor)
  expect(document.activeElement).toBe(doctor)
  f.region.open('appearance')
  expect(f.region.pane('computer-use')?.hidden).toBe(true)
  f.region.open('computer-use')
  expect(f.button('doctor-run')).toBe(doctor)
  const model = f.region.pane('model')
  const restore = await f.replace()
  await restore()
  expect(f.region.pane('computer-use')?.hidden).toBe(false)
  expect(f.region.pane('model')).toBe(model)
  f.button('doctor-run').click()
  await vi.waitFor(() => expect(f.text('doctor-state')).toBe('Check passed'))
  expect(call.mock.calls.filter(([method]) => method.endsWith('doctor'))).toHaveLength(2)
})

it.each([
  'status',
  'permissions.status',
  'permissions.grant',
  'doctor',
  'operation.start',
  'operation.status',
  'operation.cancel',
])('rejects retired %s replies and finally through the actual settings outlet', async (route) => {
  const late = deferred()
  let hold = false
  let heldCalls = 0
  const call = vi.fn(async (method: string) => {
    if (hold && method === `_agnes/v1/computerUse.${route}`) {
      heldCalls++
      return late.promise
    }
    if (method.endsWith('operation.start')) return running
    if (method.endsWith('operation.cancel')) return cancelled
    return normal(method)
  })
  const f = await fixture(call, { wait: () => new Promise(() => {}) })
  await f.settled()
  hold = true
  let action: Promise<void>
  if (route === 'status' || route === 'permissions.status') action = f.owner.refresh()
  else if (route === 'permissions.grant') action = f.owner.grantPermissions()
  else if (route === 'doctor') action = f.owner.doctor()
  else if (route === 'operation.start') action = f.owner.install()
  else if (route === 'operation.status') action = f.owner.refreshOperation()
  else {
    void f.owner.install()
    await vi.waitFor(() => expect(f.text('operation-state')).toBe('Installing'))
    action = f.owner.cancelOperation()
  }
  await vi.waitFor(() => expect(heldCalls).toBe(1))
  const restore = await f.replace()
  hold = false
  await restore()
  const before = f.host.innerHTML
  late.resolve(
    route.startsWith('operation.')
      ? cancelled
      : route.startsWith('permissions.')
        ? granted
        : route === 'doctor'
          ? { status: 'failed' }
          : { ...ready, driver: { platform: 'linux', version: 'stale' } },
  )

  await action
  await new Promise((done) => setTimeout(done, 0))
  expect(f.host.innerHTML).toBe(before)
  f.button('doctor-run').click()
  await vi.waitFor(() => expect(f.text('doctor-state')).toBe('Check passed'))
  expect(f.text('summary')).not.toContain('stale')
  expect(call.mock.calls.filter(([method]) => method.endsWith('operation.cancel'))).toHaveLength(
    route === 'operation.cancel' ? 1 : 0,
  )
})

it('does not duplicate explicit maintenance in StrictMode and aborts waits when unmounted', async () => {
  let signal: AbortSignal | undefined
  const call = vi.fn(async (method: string) =>
    method.endsWith('operation.start') ? running : normal(method),
  )
  const f = await fixture(
    call,
    {
      wait: (_delay, abort) => {
        signal = abort
        return new Promise(() => {})
      },
    },
    true,
  )
  await f.settled()
  f.button('install').click()
  f.button('install').click()
  await vi.waitFor(() => expect(f.text('operation-state')).toBe('Installing'))
  expect(call.mock.calls.filter(([method]) => method.endsWith('operation.start'))).toHaveLength(1)
  f.region.open('appearance')
  expect(signal?.aborted).toBe(false)
  const restore = await f.replace()
  expect(signal?.aborted).toBe(true)
  await restore()
  f.owner.dispose()
  f.owner.dispose()
  await f.owner.install()
  expect(call.mock.calls.filter(([method]) => method.endsWith('operation.start'))).toHaveLength(1)
  expect(call.mock.calls.some(([method]) => method.endsWith('operation.cancel'))).toBe(false)
})

it('rediscovers a running maintenance ID after remount, confirms cancellation, then accepts another action', async () => {
  let active = false
  let finished = false
  const call = vi.fn(async (method: string) => {
    if (method.endsWith('operation.start')) {
      active = true
      return { ...running, kind: 'update' }
    }
    if (method.endsWith('operation.status'))
      return active
        ? { ...running, kind: 'update', ...(finished ? { state: 'cancelled' } : {}) }
        : { status: 'not-found' }
    if (method.endsWith('operation.cancel')) {
      finished = true
      return cancelled
    }
    return normal(method)
  })
  const f = await fixture(call, { wait: () => new Promise(() => {}) })
  await f.settled()
  f.button('update').click()
  await vi.waitFor(() => expect(f.text('operation-state')).toBe('Installing'))
  const restore = await f.replace()
  await restore()
  await vi.waitFor(() => expect(f.text('operation-state')).toBe('Installing'))
  expect(call).toHaveBeenCalledWith('_agnes/v1/computerUse.operation.status', {})
  expect(f.button('update').disabled).toBe(true)
  f.button('operation-cancel').click()
  await vi.waitFor(() => expect(f.text('operation-state')).toBe('Cancelled'))
  expect(call).toHaveBeenCalledWith('_agnes/v1/computerUse.operation.cancel', { operationId: 'cu-fixture' })
  await f.settled()
  expect(f.button('update').disabled).toBe(false)
  f.button('update').click()
  await vi.waitFor(() =>
    expect(call.mock.calls.filter(([method]) => method.endsWith('operation.start'))).toHaveLength(2),
  )
})

it.each([
  ['feature-disabled', 'Turned off', true],
  ['platform-unsupported', 'Not supported on this system', true],
  ['driver-not-prepared', 'Prepares automatically on first use', false],
  ['driver-preparing', 'Preparing', true],
  ['driver-prepare-failed', 'Preparation failed', false],
])('renders blocked %s and retry eligibility from the real state', async (blocker, label, disabled) => {
  const call = vi.fn(async (method: string) =>
    method.endsWith('operation.status')
      ? { status: 'not-found' }
      : {
          status: 'blocked',
          admission: { reason: 'runtime-unavailable' },
          blockers: [blocker],
        },
  )
  const f = await fixture(call, { wait: () => new Promise(() => {}) })
  await f.settled()
  expect(f.text('state')).toBe(label)
  expect(f.button('install').disabled).toBe(disabled)
  expect(f.button('update').disabled).toBe(true)
  expect(f.button('permission-grant').hidden).toBe(true)
  expect(call.mock.calls.some(([method]) => method.endsWith('permissions.status'))).toBe(false)
})

it.each([
  ['required', 'Authorization required', false],
  ['granted', 'Authorized', true],
  ['not-required', 'No system authorization required', true],
  ['unknown', 'Could not confirm', true],
  ['unavailable', 'Unavailable', true],
])('renders permission %s without inventing authorization', async (status, label, hidden) => {
  const call = vi.fn(async (method: string) =>
    method.endsWith('permissions.status')
      ? {
          ...required,
          status,
          admission: { reason: 'linux-verified-driver' },
        }
      : normal(method),
  )
  const f = await fixture(call)
  await f.settled()
  expect(f.text('permission-state')).toBe(label)
  expect(f.button('permission-grant').hidden).toBe(hidden)
  expect(f.text('runtime')).toBe('Runtime: 0 active sessions')
})

it.each([
  ['ready', 'Check passed'],
  ['failed', 'Check failed'],
  ['unreachable', 'Could not connect'],
  ['unavailable', 'Not run'],
])('renders doctor %s through its action and confirmed result', async (status, label) => {
  const call = vi.fn(async (method: string) =>
    method.endsWith('doctor') ? { status, admission: { reason: 'linux-verified-driver' } } : normal(method),
  )
  const f = await fixture(call)
  await f.settled()
  await f.owner.doctor()
  await vi.waitFor(() => expect(f.text('doctor-state')).toBe(label))
  expect(f.button('doctor-run').disabled).toBe(false)
})

it.each([
  ['queued', 'Waiting to run', false],
  ['running', 'Installing', false],
  ['cancelling', 'Cancelling', false],
  ['succeeded', 'Operation finished', true],
  ['failed', 'Operation failed', true],
  ['cancelled', 'Cancelled', true],
])('hydrates operation %s with the backend ID and correct controls', async (state, label, terminal) => {
  const call = vi.fn(async (method: string) =>
    method.endsWith('operation.status') ? { ...running, state, outcome: undefined } : normal(method),
  )
  const f = await fixture(call, { wait: () => new Promise(() => {}) })
  await vi.waitFor(() => expect(f.text('operation-state')).toBe(label))
  await vi.waitFor(() => expect(f.button('operation-refresh').disabled).toBe(false))
  expect(f.button('operation-cancel').hidden).toBe(terminal)
  expect(f.button('update').disabled).toBe(!terminal)
  expect(call).toHaveBeenCalledWith('_agnes/v1/computerUse.operation.status', {})
})

it('clears old details on RPC failure and exposes safe retry text', async () => {
  let failed = false
  const call = vi.fn(async (method: string) => {
    if (failed) throw new Error('credential=/private/synthetic-secret')
    return normal(method)
  })
  const f = await fixture(call)
  await f.settled()
  failed = true
  await f.owner.refresh()
  await f.owner.doctor()
  await vi.waitFor(() => expect(f.text('state')).toBe('Could not read status'))
  expect(f.text('runtime')).toBe('')
  expect(f.text('permission-state')).toBe('Could not read permissions')
  expect(f.text('doctor-state')).toBe('Check failed')
  expect(f.host.textContent).not.toContain('synthetic-secret')
  expect(f.button('update').disabled).toBe(true)
})

it('releases the pane state through actual client-module unit removal and runtime reconstruction', async () => {
  const late = deferred()
  let hold = false
  let signal: AbortSignal | undefined
  const call = vi.fn(async (method: string) => {
    if (method.endsWith('operation.start')) return hold ? late.promise : running
    return normal(method)
  })
  const owner = createComputerUsePaneController(
    { call: call as ComputerUseStatusClient['call'] },
    {
      wait: (_delay, abort) => {
        signal = abort
        return new Promise(() => {})
      },
    },
  )
  const host = document.createElement('div')
  document.body.append(host)
  const boot = () =>
    startClientModules({
      agnes: { call } as unknown as AgnesClient,
      rosterSource: { list: async () => ({ revision: '', modules: [], statuses: [] }) },
      settingsPaneContainer: host,
      settings: { computerUse: owner.render() },
    })
  const first = await boot()
  let second: Awaited<ReturnType<typeof boot>> | undefined
  try {
    await vi.waitFor(() => expect(host.querySelector('#computer-use-state')?.textContent).toBe('Running'))
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLButtonElement>('#computer-use-update')?.disabled).toBe(false),
    )
    hold = true
    const starting = owner.install()
    expect(call).toHaveBeenCalledWith('_agnes/v1/computerUse.operation.start', { kind: 'install' })
    first.builtinUnits.unmount('@agnes/web-settings-computer-use')
    expect(host.querySelector('#computer-use-state')).toBeNull()
    expect(first.settings?.pane('model')).not.toBeNull()
    late.resolve(running)
    await starting
    expect(signal).toBeUndefined()
    await first.dispose()
    hold = false
    second = await boot()
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLButtonElement>('#computer-use-update')?.disabled).toBe(false),
    )
    void owner.update()
    await vi.waitFor(() =>
      expect(host.querySelector('#computer-use-operation-state')?.textContent).toBe('Installing'),
    )
    await second.dispose()
    expect(signal?.aborted).toBe(true)
    const calls = call.mock.calls.length
    await owner.refresh()
    await owner.update()
    expect(call.mock.calls).toHaveLength(calls)
    expect(call.mock.calls.some(([method]) => method.endsWith('operation.cancel'))).toBe(false)
  } finally {
    owner.dispose()
    await first.dispose()
    await second?.dispose()
    host.remove()
  }
})

it('restores only the selected pane after repeated replacement and a navigation change', async () => {
  const call = vi.fn(async (method: string) => normal(method))
  const f = await fixture(call)
  await f.settled()
  for (let attempt = 0; attempt < 3; attempt++) {
    f.region.open('computer-use')
    const restore = await f.replace()
    f.region.open('appearance')
    await restore()
    expect(f.region.pane('computer-use')?.hidden).toBe(true)
    expect(f.region.pane('appearance')?.hidden).toBe(false)
    f.region.open('computer-use')
    f.button('doctor-run').click()
    await vi.waitFor(() => expect(f.text('doctor-state')).toBe('Check passed'))
  }
  expect(call.mock.calls.filter(([method]) => method.endsWith('doctor'))).toHaveLength(3)
  expect(call.mock.calls.some(([method]) => method.endsWith('operation.start'))).toBe(false)
})
