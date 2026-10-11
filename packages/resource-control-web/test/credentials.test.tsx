/** @vitest-environment happy-dom */

import type { AdminCredentialMetadata } from '@agnes/protocol/gen/app-server'

import { mountRegion } from '@agnes/web-ui'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { CredentialsPage } from '../src/credentials.js'
import { CredentialError, CredentialsApi } from '../src/credentials-api.js'

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })
const canary = 'SYNTHETIC_CREDENTIAL_CANARY_40972'
const item: AdminCredentialMetadata = {
  id: 'secret://generic/12345678-1234-1234-1234-123456789012',
  label: 'Service key',
  kind: 'api-key',
  createdAt: '2026-10-11T12:00:00Z',
  references: [],
}
const context = {
  profile: 'default',
  clientId: 'test',
  permissions: ['packages.read', 'packages.activate', 'credentials.read', 'credentials.write'],
  readOnly: false,
}
const node = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.querySelector<T>(`[data-testid="${id}"]`)!
const click = async (id: string) => {
  await act(async () => node<HTMLButtonElement>(id).click())
}
const fill = async (id: string, value: string) => {
  await act(async () => {
    const input = node<HTMLInputElement>(id)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const cleanDom = () =>
  !document.body.innerHTML.includes(canary) &&
  ![...document.querySelectorAll<HTMLInputElement>('input,textarea')].some((input) =>
    input.value.includes(canary),
  )
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

it('creates, rotates and renames write-only values; reviews changing references and confirms forced deletion', async () => {
  let items: AdminCredentialMetadata[] = []
  let referenced = false
  const writes: Array<{ path: string; force?: boolean; confirm?: boolean }> = []
  const responses: string[] = []
  const fetcher: typeof fetch = vi.fn(async (input, init) => {
    const path = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    let response: Response
    if (path.endsWith('/context')) response = Response.json(context)
    else if (path === '/admin/api/credentials') response = Response.json({ items })
    else {
      // Deliberately retain only non-secret request facts, including in failed assertions.
      writes.push({ path, ...(body.force ? { force: body.force, confirm: body.confirm } : {}) })
      if (path.endsWith('/create')) {
        items = [{ ...item, label: body.label }]
        response = Response.json(items[0])
      } else if (path.endsWith('/set')) response = Response.json(items[0])
      else if (path.endsWith('/rename')) {
        items = [{ ...items[0]!, label: body.label }]
        response = Response.json(items[0])
      } else if (referenced && !body.force) {
        items = [{ ...items[0]!, references: [{ kind: 'mcp', profile: 'default', configId: 'service-a' }] }]
        response = Response.json(
          { error: { data: { cause: { code: 'CONFIG_CREDENTIAL_REFERENCED' } } } },
          { status: 409 },
        )
      } else {
        items = []
        response = Response.json({})
      }
    }
    responses.push(await response.clone().text())
    return response
  })
  const host = document.createElement('div')
  document.body.append(host)
  let dispose!: () => void
  await act(async () => {
    dispose = mountRegion(host, <CredentialsPage api={new CredentialsApi(fetcher)} />)
  })
  try {
    await click('credential-create')
    await fill('credential-label', 'Service key')
    await fill('credential-value', canary)
    const draft = node<HTMLInputElement>('credential-value')
    expect(draft.type).toBe('password')
    await click('credential-show')
    expect(draft.type).toBe('text')
    await click('credential-save')
    expect(draft.value === '').toBe(true)
    expect(cleanDom()).toBe(true)
    expect(responses.every((value) => !value.includes(canary))).toBe(true)
    expect(node('credential-row').textContent).toContain('API key')
    const menu = async () => {
      await act(async () =>
        node('credential-row').querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click(),
      )
    }
    await menu()
    await click('credential-replace')
    await fill('credential-value', canary)
    const replacement = node<HTMLInputElement>('credential-value')
    await click('credential-save')
    expect(replacement.value === '').toBe(true)
    expect(cleanDom()).toBe(true)
    await menu()
    await click('credential-rename')
    await fill('credential-label', 'Renamed key')
    await click('credential-save')
    expect(node('credential-row').textContent).toContain('Renamed key')
    referenced = true
    await menu()
    await click('credential-delete')
    await click('credential-delete-confirm')
    expect(node('credential-delete-error').textContent).toContain('not deleted')
    expect(node('credential-force-confirm')).toBeTruthy()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('service-a')
    await click('credential-delete-cancel')
    expect(writes.filter((write) => write.path.endsWith('/delete'))).toHaveLength(1)
    await menu()
    await click('credential-delete')
    await click('credential-force-confirm')
    await click('credential-delete-confirm')
    expect(writes.at(-1)).toEqual({ path: '/admin/api/credentials/delete', force: true, confirm: true })
    expect(document.querySelector('[data-testid="credential-row"]')).toBeNull()
    expect(cleanDom()).toBe(true)
    expect(responses.every((value) => !value.includes(canary))).toBe(true)
  } finally {
    await act(async () => dispose())
  }
})

it.each([
  ['readOnly', { ...context, readOnly: true, permissions: ['packages.read', 'credentials.read'] }],
  ['denied', { ...context, permissions: ['packages.read', 'credentials.read'] }],
] as const)('keeps metadata readable in %s mode and prevents writes', async (reason, access) => {
  const fetcher: typeof fetch = vi.fn(async (input) =>
    Response.json(String(input).endsWith('/context') ? access : { items: [item] }),
  )
  const host = document.createElement('div')
  document.body.append(host)
  let dispose!: () => void
  await act(async () => {
    dispose = mountRegion(host, <CredentialsPage api={new CredentialsApi(fetcher)} />)
  })
  try {
    expect(node<HTMLButtonElement>('credential-create').disabled).toBe(true)
    expect(node('credential-row').textContent).toContain('Service key')
    expect(document.body.textContent).toContain(reason === 'readOnly' ? 'read-only' : 'permission')
    expect(fetcher).toHaveBeenCalledTimes(2)
  } finally {
    await act(async () => dispose())
  }
})

it('rejects value echoes and reduces permission, storage and read-only failures to safe reasons', async () => {
  const echo = new CredentialsApi(async () => Response.json({ ...item, value: canary }))
  await expect(echo.create('Service key', canary)).rejects.toEqual(new CredentialError('unavailable'))
  for (const [status, code, reason] of [
    [403, 'E_ADMIN_FORBIDDEN', 'denied'],
    [409, 'E_ADMIN_READ_ONLY', 'readOnly'],
    [503, 'CONFIG_CREDENTIAL_STORE', 'unavailable'],
  ] as const) {
    const api = new CredentialsApi(async () =>
      Response.json({ error: { code, message: canary, data: { value: canary } } }, { status }),
    )
    try {
      await api.create('Service key', canary)
      throw new Error('expected refusal')
    } catch (error) {
      expect(error).toEqual(new CredentialError(reason))
      expect(String(error).includes(canary)).toBe(false)
    }
  }
  const host = document.createElement('div')
  document.body.append(host)
  let dispose!: () => void
  await act(async () => {
    dispose = mountRegion(
      host,
      <CredentialsPage
        api={
          new CredentialsApi(async (input) =>
            String(input).endsWith('/context')
              ? Response.json(context)
              : Response.json({ error: { message: canary } }, { status: 503 }),
          )
        }
      />,
    )
  })
  try {
    expect(node('credentials-error').textContent).toContain('unavailable')
    expect(cleanDom()).toBe(true)
  } finally {
    await act(async () => dispose())
  }
})
