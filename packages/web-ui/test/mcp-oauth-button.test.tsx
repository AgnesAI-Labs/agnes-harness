/** @vitest-environment happy-dom */
import type { McpServerDescriptor } from '@agnes/protocol'
import { act, createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { McpDetailContent, mountRegion } from '../src/index.js'

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })

let dispose: () => void = () => undefined
afterEach(async () => {
  await act(async () => dispose())
  document.body.replaceChildren()
})

const server = {
  kind: 'mcp',
  resourceId: 'mcp/tracker',
  serverId: 'tracker',
  displayName: 'Tracker',
  revision: 'a'.repeat(64),
  definition: {
    serverId: 'tracker',
    displayName: 'Tracker',
    transport: { kind: 'http', url: 'https://tracker.example.com/mcp' },
    secretBinding: { kind: 'oauth' },
  },
  transportKind: 'http',
  secretBindingKind: 'oauth',
  authorizationStatus: 'pending',
  trust: 'trusted',
  desired: 'enabled',
  actual: 'ready',
  source: 'managed',
} as unknown as McpServerDescriptor

async function mount(onAuthorize?: () => void) {
  const host = document.createElement('div')
  document.body.append(host)
  await act(async () => {
    dispose = mountRegion(
      host,
      createElement(McpDetailContent, {
        server,
        disabled: false,
        actions: [],
        onAction: () => undefined,
        onStatus: async () => [],
        onTools: async () => ({ items: [], nextCursor: undefined }),
        onEdit: () => undefined,
        onClose: () => undefined,
        ...(onAuthorize ? { onAuthorize } : {}),
      }),
    )
  })
  return host
}

it('the Authorize button is a real button that starts the sign-in in this tab', async () => {
  const onAuthorize = vi.fn()
  const host = await mount(onAuthorize)
  const button = host.querySelector<HTMLButtonElement>('[data-testid="mcp-oauth-authorize"]')
  expect(button?.tagName).toBe('BUTTON')
  expect(button?.getAttribute('href')).toBeNull()
  await act(async () => button?.click())
  expect(onAuthorize).toHaveBeenCalledTimes(1)
})
