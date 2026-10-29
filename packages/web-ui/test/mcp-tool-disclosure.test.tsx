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

async function mount(
  descriptor: McpServerDescriptor,
  onToolDisclosure?: (mode: string) => void,
  onTools?: Parameters<typeof McpDetailContent>[0]['onTools'],
) {
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
        onTools: onTools ?? (async () => ({ items: [], nextCursor: undefined })),
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

it('shows concise tool summaries and reveals complete descriptions and parameter definitions on request', async () => {
  const description =
    'Retrieves current documentation.\n\nYou MUST resolve a library first.\n<img src=x onerror=alert(1)>\n- Do not call more than three times.'
  const tool = {
    name: 'query-docs',
    description,
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'The question to look up.' },
        language: { type: 'string', description: 'Preferred language.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  }
  const host = await mount(server(), undefined, async (cursor) => ({
    items: cursor ? [{ ...tool, name: 'resolve-library-id', description: '' }] : [tool],
    nextCursor: cursor ? undefined : 'page-2',
  }))
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === label || node.getAttribute('aria-label') === label,
    )
  await act(async () => button('View tool catalog')?.click())
  expect(host.querySelectorAll('.mcp-tool-card')).toHaveLength(1)
  expect(host.querySelector('.mcp-tool-card')?.textContent).toContain('Retrieves current documentation.')
  expect(host.querySelector('.mcp-tool-card')?.textContent).not.toContain('You MUST')
  await act(async () => button('View query-docs details')?.click())
  expect(host.querySelector('.mcp-tool-description')?.textContent).toBe(description)
  expect(host.querySelectorAll('img')).toHaveLength(0)
  const parameters = host.querySelector('.mcp-tool-parameters')
  expect(parameters?.textContent).toContain('query')
  expect(parameters?.textContent).toContain('string')
  expect(parameters?.textContent).toContain('Required')
  expect(parameters?.textContent).toContain('Optional')
  await act(async () => button('View input schema')?.click())
  expect(JSON.parse(host.querySelector('pre')?.textContent ?? '{}')).toEqual(tool.inputSchema)
  await act(async () => button('Load more tools')?.click())
  expect(host.querySelectorAll('.mcp-tool-card')).toHaveLength(2)
  expect(host.querySelector('.mcp-tool-description')?.textContent).toBe(description)
  expect(host.textContent).toContain('No description provided.')
  await act(async () => button('View query-docs details')?.click())
  expect(host.querySelector('.mcp-tool-description')).toBeNull()
})
