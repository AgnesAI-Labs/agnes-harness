/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

let disposeShell: (() => void) | undefined
afterEach(() => {
  disposeShell?.()
  disposeShell = undefined
  document.documentElement.lang = 'en'
  document.documentElement.removeAttribute('data-agnes-shell')
  document.documentElement.replaceChildren(document.createElement('head'), document.createElement('body'))
  localStorage.clear()
})

it('translates the MCP transports and confirmation of the workbench on the blocking boot path', async () => {
  document.documentElement.innerHTML = readFileSync(
    join(resolve(import.meta.dirname, '../../..'), 'packages/web/public/index.html'),
    'utf8',
  ).replace(/<link rel="stylesheet" href="\/(?:style|antd|tokens)\.css" \/>/g, '')
  localStorage.setItem('agnes-locale', 'zh-CN')
  vi.resetModules()

  await import('../src/theme-boot.js')
  const { mountAppShell } = await import('../src/app-shell.js')
  disposeShell = mountAppShell().dispose

  expect(document.querySelector('#admin-confirm .eyebrow')?.textContent).toBe('需要确认')
  const transport = document.querySelector<HTMLSelectElement>('#mcp-transport')
  expect(Array.from(transport?.options ?? [], (option) => option.value)).toEqual(['stdio', 'http', 'sse'])
  expect(transport?.querySelector('[value="sse"]')?.textContent).toBe('SSE（远程，旧版协议）')
  window.dispatchEvent(new CustomEvent('agnes:locale-changed', { detail: 'en' }))
  await vi.waitFor(() =>
    expect(transport?.querySelector('[value="sse"]')?.textContent).toBe('SSE (remote, legacy protocol)'),
  )
})
