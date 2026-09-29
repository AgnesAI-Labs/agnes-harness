/** @vitest-environment happy-dom */
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import {
  SettingsComputerUse,
  type SettingsComputerUseActions,
  type SettingsComputerUseView,
} from '../src/settings-computer-use.js'

const view: SettingsComputerUseView = {
  status: { label: '已阻止', summary: '<script>unsafe</script>', runtime: '', blockers: ['证据缺失'] },
  permissions: { label: '需要授权', summary: 'macOS 权限', grantHidden: false },
  doctor: { label: '检查失败', summary: '无法验证' },
  operation: { label: '正在安装', summary: '驱动准备中' },
  controls: {
    refreshDisabled: false,
    grantDisabled: false,
    doctorDisabled: false,
    installDisabled: true,
    updateDisabled: true,
    restartDisabled: true,
    operationRefreshDisabled: false,
    cancelDisabled: false,
    cancelHidden: false,
  },
}

it('renders four sections, safe text and snapshot controls through stable accessible buttons', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const actions: SettingsComputerUseActions = {
    refresh: vi.fn(async () => {}),
    grantPermissions: vi.fn(async () => {}),
    doctor: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    refreshOperation: vi.fn(async () => {}),
    cancelOperation: vi.fn(async () => {}),
  }
  const render = (next: SettingsComputerUseView) =>
    flushSync(() => root.render(createElement(SettingsComputerUse, { view: next, actions })))
  try {
    render(view)
    expect(host.querySelectorAll('.config-card')).toHaveLength(4)
    expect(host.querySelector('#computer-use-state')?.getAttribute('role')).toBe('status')
    expect(host.querySelector('#computer-use-summary')?.textContent).toBe('<script>unsafe</script>')
    expect(host.querySelector('script')).toBeNull()
    expect(host.querySelector('#computer-use-blockers')?.textContent).toBe('证据缺失')
    const refresh = host.querySelector<HTMLButtonElement>('#computer-use-refresh')
    if (!refresh) throw new Error('refresh missing')
    const focused = host.querySelector<HTMLButtonElement>('#computer-use-doctor-run')
    if (!focused) throw new Error('doctor missing')
    focused.focus()
    refresh.click()
    host.querySelector<HTMLButtonElement>('#computer-use-install')?.click()
    host.querySelector<HTMLButtonElement>('#computer-use-operation-cancel')?.click()
    expect(actions.refresh).toHaveBeenCalledTimes(1)
    expect(actions.install).not.toHaveBeenCalled()
    expect(actions.cancelOperation).toHaveBeenCalledTimes(1)
    render({
      ...view,
      status: { label: '可用', summary: '已就绪', runtime: '0 个会话', blockers: [] },
      permissions: { label: '已授权', summary: '授权已确认', grantHidden: true },
      controls: { ...view.controls, cancelHidden: true, refreshDisabled: true },
    })
    expect(host.querySelector('#computer-use-refresh')).toBe(refresh)
    expect(document.activeElement).toBe(focused)
    expect(refresh.disabled).toBe(true)
    expect(host.querySelector('#computer-use-blockers')?.children).toHaveLength(0)
    expect(host.querySelector<HTMLButtonElement>('#computer-use-permission-grant')?.hidden).toBe(true)
    expect(host.querySelector<HTMLButtonElement>('#computer-use-operation-cancel')?.hidden).toBe(true)
    expect(host.querySelector('#computer-use-runtime')?.textContent).toBe('0 个会话')
  } finally {
    root.unmount()
    host.remove()
  }
})
