/** @vitest-environment happy-dom */
import type { McpServerDescriptor } from '@agnes/protocol'
import { act, createElement } from 'react'
import { afterEach, expect, it } from 'vitest'
import { McpDetailContent, mountRegion, setAdvancedSettingsShown } from '../src/index.js'

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })

let dispose: () => void = () => undefined
afterEach(async () => {
  await act(async () => dispose())
  document.body.replaceChildren()
  setAdvancedSettingsShown(true)
})

const server = (toolDisclosure?: 'auto' | 'always' | 'on-demand') =>
  ({
    kind: 'mcp',
    resourceId: 'mcp/tracker',
    serverId: 'tracker',
    displayName: 'Tracker',
    revision: 'a'.repeat(64),
    definition: {
      serverId: 'tracker',
      displayName: 'Tracker',
      transport: { kind: 'stdio', executable: 'tracker-mcp', args: [] },
      secretBinding: { kind: 'none' },
      ...(toolDisclosure ? { toolDisclosure } : {}),
    },
    transportKind: 'stdio',
    secretBindingKind: 'none',
    trust: 'trusted',
    desired: 'enabled',
    actual: 'ready',
    source: 'managed',
  }) as McpServerDescriptor

async function mount(descriptor: McpServerDescriptor, onToolDisclosure?: (mode: string) => void) {
  const host = document.createElement('div')
  document.body.append(host)
  await act(async () => {
    dispose = mountRegion(
      host,
      createElement(McpDetailContent, {
        server: descriptor,
        disabled: false,
        actions: [],
        onAction: () => undefined,
        onStatus: async () => [],
        onTools: async () => ({ names: [], nextCursor: undefined }),
        onEdit: () => undefined,
        onClose: () => undefined,
        ...(onToolDisclosure ? { onToolDisclosure } : {}),
      }),
    )
  })
  return host
}

it('offers the tool loading mode in the advanced group and saves only a changed choice', async () => {
  const saved: string[] = []
  const host = await mount(server(), (mode) => saved.push(mode))
  const group = host.querySelector('[data-testid="mcp-tool-disclosure"]')
  expect(group?.textContent).toContain('Automatic')
  const radio = (mode: string) =>
    host.querySelector<HTMLInputElement>(
      `[data-testid="mcp-tool-disclosure-${mode}"] input, input[value="${mode}"]`,
    )
  expect(radio('auto')?.checked).toBe(true)
  await act(async () => radio('on-demand')?.click())
  await act(async () => radio('auto')?.click())
  expect(saved).toEqual(['on-demand'])
})

it('reads a stored mode, and hides the control without a writer or with advanced settings off', async () => {
  expect((await mount(server('always'))).querySelector('[data-testid="mcp-tool-disclosure"]')).toBeNull()
  await act(async () => dispose())
  const host = await mount(server('always'), () => undefined)
  expect(host.querySelector<HTMLInputElement>('input[value="always"]')?.checked).toBe(true)
  await act(async () => setAdvancedSettingsShown(false))
  expect(host.querySelector('[data-testid="mcp-tool-disclosure"]')).toBeNull()
})
