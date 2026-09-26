import { createElement } from 'react'
import { startClientModules } from '../../../packages/web/src/client-modules/boot.ts'
import { createComputerUsePaneController } from '../../../packages/web/src/computer-use-pane.tsx'
import { settingsPaneSlot } from '../../../packages/web/src/region-slots.ts'

const requests = []
const holds = new Map()
const ready = {
  status: 'ready',
  driver: { platform: 'darwin', version: 'fixture' },
  runtime: { state: 'running', activeSessions: 0 },
}
const operation = {
  status: 'found',
  operationId: 'cu-browser',
  kind: 'update',
  state: 'running',
  phase: 'installing',
}
let report = ready
let permissions = { status: 'required', probe: { accessibility: false, screenRecording: false } }
let doctor = { status: 'ready', admission: { reason: 'macos-verified-driver' } }
let activeOperation = { status: 'not-found' }
let fail = false
const call = async (method, params) => {
  requests.push({ method, params })
  if (holds.has(method))
    return new Promise((resolve) => {
      holds.set(method, resolve)
    })
  if (fail) throw new Error('synthetic-private-credential')
  if (method.endsWith('permissions.status')) return permissions
  if (method.endsWith('permissions.grant')) {
    permissions = { status: 'granted' }
    return permissions
  }
  if (method.endsWith('doctor')) return doctor
  if (method.endsWith('operation.start')) {
    activeOperation = operation
    return operation
  }
  if (method.endsWith('operation.cancel')) {
    activeOperation = { ...operation, state: 'cancelled', phase: 'complete' }
    return activeOperation
  }
  if (method.endsWith('operation.status')) return activeOperation
  return report
}
const owner = createComputerUsePaneController({ call }, { intervalMs: 50, maxAttempts: 60 })
const host = document.getElementById('config')
const runtime = await startClientModules({
  agnes: { call },
  rosterSource: { list: async () => ({ revision: '', modules: [], statuses: [] }) },
  settingsPaneContainer: host,
  settings: {
    computerUse: owner.render(),
    onChange: ({ pane }) => {
      if (pane === 'computer-use') void owner.refresh()
    },
  },
})
host.showModal()
runtime.settings.open('computer-use')
let restore
window.__computerUseProbe = {
  requests,
  async replace() {
    restore = runtime.registry.register(
      { name: settingsPaneSlot('computer-use'), owner: 'browser-fixture', priority: -1 },
      () => createElement('section', { id: 'cu-replacement' }, '替换面板'),
    )
  },
  restore() {
    restore?.()
    restore = undefined
  },
  hide() {
    runtime.settings.open('appearance')
  },
  show() {
    runtime.settings.open('computer-use')
  },
  hold(route) {
    holds.set(`_agnes/v1/computerUse.${route}`, null)
  },
  release(route, value) {
    const resolve = holds.get(`_agnes/v1/computerUse.${route}`)
    holds.delete(`_agnes/v1/computerUse.${route}`)
    resolve?.(value)
  },
  configure(value) {
    report = value.report ?? ready
    permissions = value.permissions ?? {
      status: 'required',
      probe: { accessibility: false, screenRecording: false },
    }
    doctor = value.doctor ?? { status: 'ready', admission: { reason: 'macos-verified-driver' } }
    activeOperation = value.operation ?? { status: 'not-found' }
    fail = value.fail ?? false
  },
  refresh: () => owner.refresh(),
  async dispose() {
    owner.dispose()
    await runtime.dispose()
  },
}
window.addEventListener('pagehide', () => owner.dispose(), { once: true })
