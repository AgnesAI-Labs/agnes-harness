/** @vitest-environment happy-dom */
import { createComputerUsePaneController } from '@agnes/web-conversation/computer-use-pane'
import type {
  ComputerUseOperationPolling,
  ComputerUseStatusClient,
} from '@agnes/web-conversation/computer-use-state'
import { createElement, StrictMode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

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

/**
 * The controller's capability view, as the plugins page hosts it. `replace` takes the view off the
 * page and puts it back, the way leaving and re-entering the capability page does.
 */
async function fixture(
  call: ReturnType<typeof vi.fn>,
  polling: ComputerUseOperationPolling = {},
  strict = false,
) {
  const owner = createComputerUsePaneController({ call: call as ComputerUseStatusClient['call'] }, polling)
  const host = document.createElement('div')
  document.body.append(host)
  let root = createRoot(host)
  const view = () =>
    strict ? createElement(StrictMode, null, owner.renderCapability()) : owner.renderCapability()
  flushSync(() => root.render(view()))
  cleanups.push(async () => {
    root.unmount()
    owner.dispose()
    host.remove()
  })
  const text = (id: string) => host.querySelector(`[data-testid="computer-use-${id}"]`)?.textContent
  // The capability view only renders an action while it applies: an absent action reads as hidden
  // and disabled, which is what it is to the person looking at the page.
  const button = (id: string) =>
    host.querySelector<HTMLButtonElement>(`[data-testid="computer-use-${id}"]`) ??
    Object.assign(document.createElement('button'), { hidden: true, disabled: true })
  const settled = () => vi.waitFor(() => expect(button('refresh').disabled).toBe(false))
  const replace = async () => {
    root.unmount()
    expect(host.querySelector('[data-testid="computer-use-capability"]')).toBeNull()
    return async () => {
      root = createRoot(host)
      flushSync(() => root.render(view()))
      await vi.waitFor(() => expect(text('state')).toBe('Running'))
      await vi.waitFor(() => expect(text('permission-state')).toBe('Authorization required'))
      await vi.waitFor(() => expect(button('operation-refresh').disabled).toBe(false))
    }
  }
  return { owner, host, text, button, settled, replace }
}

const normal = (method: string) =>
  method.endsWith('operation.status')
    ? { status: 'not-found' }
    : method.endsWith('permissions.status')
      ? required
      : method.endsWith('doctor')
        ? { status: 'ready', admission: { reason: 'macos-verified-driver' } }
        : ready

it('keeps focus and controls through status updates, and comes back whole after leaving the page', async () => {
  const call = vi.fn(async (method: string) => normal(method))
  const f = await fixture(call)
  await f.settled()
  const doctor = f.button('doctor-run')
  doctor.focus()
  doctor.click()
  await vi.waitFor(() => expect(f.text('doctor-state')).toBe('Check passed'))
  expect(f.button('doctor-run')).toBe(doctor)
  expect(document.activeElement).toBe(doctor)
  const restore = await f.replace()
  await restore()
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
])('rejects retired %s replies after the view left the page and returned', async (route) => {
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
  f.button('update').click()
  f.button('update').click()
  await vi.waitFor(() => expect(f.text('operation-state')).toBe('Installing'))
  expect(call.mock.calls.filter(([method]) => method.endsWith('operation.start'))).toHaveLength(1)
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
