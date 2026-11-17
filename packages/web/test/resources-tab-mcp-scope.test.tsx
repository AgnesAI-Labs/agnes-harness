/** @vitest-environment happy-dom */
import { PushStack, searchParamRoute } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ResourcesTab } from '../src/pages/plugins/resources-tab.js'
import { mountRenderedIndex } from './web-dom-fixture.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let runtime: Awaited<ReturnType<typeof mountRenderedIndex>> | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  await runtime?.dispose()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it('keeps a profile MCP detail open when the session workspace is restored or changed', async () => {
  history.replaceState(null, '', '/?page=plugins&tab=mcp')
  const server = {
    kind: 'mcp',
    resourceId: 'mcp/oauth-e2e',
    serverId: 'oauth-e2e',
    displayName: 'OAuth E2E',
    revision: 'a'.repeat(64),
    transportKind: 'http',
    secretBindingKind: 'oauth',
    trust: 'untrusted',
    desired: 'disabled',
    actual: 'disabled',
    source: 'managed',
    authorizationStatus: 'pending',
    definition: {
      serverId: 'oauth-e2e',
      displayName: 'OAuth E2E',
      transport: { kind: 'http', url: 'https://example.invalid/mcp' },
      secretBinding: { kind: 'oauth', staticClientId: 'fixture' },
    },
  }
  const lists = vi.fn(() => Response.json({ items: [server] }))
  vi.stubGlobal('fetch', async (input: string) => {
    if (input.endsWith('/context'))
      return Response.json({ profile: 'fixture', clientId: 'fixture', permissions: [], readOnly: false })
    if (input.endsWith('/mcp/list')) return lists()
    throw new Error(`Unexpected request: ${input}`)
  })
  runtime = await mountRenderedIndex()
  root = createRoot(document.body.appendChild(document.createElement('div')))
  const render = (workspaceId?: string) =>
    act(async () =>
      root?.render(
        createElement(
          PushStack,
          { rootTitle: 'Plugins', route: searchParamRoute('view') },
          createElement(ResourcesTab, {
            tab: 'mcp',
            workspaceId,
            canSave: true,
            packageName: () => undefined,
            t: (key) => key,
          }),
        ),
      ),
    )
  await render()
  await vi.waitFor(() => expect(document.querySelector('.resource-row')).not.toBeNull())
  await act(async () => document.querySelector<HTMLElement>('.resource-row')?.click())
  const assertDetail = () => {
    expect(document.querySelector('[data-testid="mcp-oauth"]')?.getAttribute('data-status')).toBe('pending')
    expect(new URL(location.href).searchParams.get('view')).toBe('mcp:mcp/oauth-e2e')
    expect(document.querySelector<HTMLDialogElement>('#resource-detail')?.open).toBe(true)
  }
  await vi.waitFor(assertDetail)
  const reads = lists.mock.calls.length
  for (const workspaceId of ['a'.repeat(64), 'b'.repeat(64), undefined]) {
    await render(workspaceId)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    assertDetail()
    expect(lists).toHaveBeenCalledTimes(reads)
  }
})
