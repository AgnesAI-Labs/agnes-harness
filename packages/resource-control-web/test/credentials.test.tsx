/** @vitest-environment happy-dom */

import type { AdminCredentialMetadata } from '@agnes/protocol/gen/app-server'

import { mountRegion, SettingsPage } from '@agnes/web-ui'
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
  const owner = document.createElement('dialog')
  owner.id = 'config'
  owner.open = true
  let modal = true
  const matches = owner.matches.bind(owner)
  Object.defineProperty(owner, 'matches', {
    value: (selector: string) => (selector === ':modal' ? modal : matches(selector)),
  })
  owner.close = () => {
    owner.open = false
    modal = false
  }
  owner.show = () => {
    owner.open = true
    modal = false
  }
  owner.showModal = () => {
    owner.open = true
    modal = true
  }
  const form = owner.appendChild(document.createElement('form'))
  form.append(host)
  document.body.append(owner)
  let dispose!: () => void
  await act(async () => {
    dispose = mountRegion(host, <CredentialsPage api={new CredentialsApi(fetcher)} />)
  })
  try {
    node<HTMLButtonElement>('credential-create').focus()
    await click('credential-create')
    expect(node('credential-editor').parentElement?.closest('form')).toBeNull()
    expect(node('credential-editor').closest('dialog')).toBe(owner)
    expect(owner.matches(':modal')).toBe(true)
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
      await act(async () => {
        const trigger = node('credential-row').querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!
        trigger.focus()
        trigger.click()
      })
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
    expect(owner.matches(':modal')).toBe(true)
    expect(node<HTMLButtonElement>('credential-delete-cancel').disabled).toBe(false)
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
    owner.remove()
  }
})

it.each([
  ['readOnly', { ...context, readOnly: true, permissions: ['packages.read', 'credentials.read'] }],
  ['denied', { ...context, permissions: ['packages.read', 'credentials.read'] }],
] as const)('keeps metadata readable in %s mode and prevents writes', async (reason, access) => {
  const paths: string[] = []
  const fetcher: typeof fetch = vi.fn(async (input) => {
    paths.push(String(input))
    return Response.json(String(input).endsWith('/context') ? access : { items: [item] })
  })
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
    expect(
      paths.every((path) => path === '/admin/plugins/api/context' || path === '/admin/api/credentials'),
    ).toBe(true)
  } finally {
    await act(async () => dispose())
  }
})

it('rejects value echoes and reduces permission, storage and read-only failures to safe reasons', async () => {
  const echo = new CredentialsApi(function (this: unknown, input) {
    if (this !== undefined) throw new Error('invalid fetch receiver')
    return Promise.resolve(
      Response.json(String(input).endsWith('/context') ? context : { ...item, value: canary }),
    )
  })
  await expect(echo.context()).resolves.toEqual(context)
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

it('opens the editor as a page of the settings page it is part of, closes it on save, and drops the draft on 返回', async () => {
  let items: AdminCredentialMetadata[] = []
  const fetcher: typeof fetch = vi.fn(async (input, init) => {
    const path = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (path.endsWith('/context')) return Response.json(context)
    if (path === '/admin/api/credentials') return Response.json({ items })
    items = [{ ...item, label: body.label }]
    return Response.json(items[0])
  })
  const host = document.body.appendChild(document.createElement('div'))
  let dispose!: () => void
  await act(async () => {
    dispose = mountRegion(
      host,
      <SettingsPage title="Permissions & security">
        <CredentialsPage api={new CredentialsApi(fetcher)} section />
      </SettingsPage>,
    )
  })
  try {
    await click('credential-create')
    // A page, not a dialog: the editor sits in the settings page's subpage.
    expect(
      document.querySelector('[data-testid="settings-subpage-credential"] [data-testid="credential-editor"]'),
    ).not.toBeNull()
    expect(document.querySelector('.agh-dialog [data-testid="credential-editor"]')).toBeNull()
    await fill('credential-label', 'Service key')
    await fill('credential-value', canary)
    await click('credential-save')
    await act(async () => {})
    expect(document.querySelector('[data-testid="credential-editor"]')).toBeNull()
    expect(document.querySelectorAll('[data-testid="credential-row"]')).toHaveLength(1)
    expect(cleanDom()).toBe(true)
    // 返回 leaves the page and drops what was typed.
    await click('credential-create')
    await fill('credential-label', 'Half typed')
    await click('settings-subpage-back')
    await act(async () => window.dispatchEvent(new PopStateEvent('popstate', { state: {} })))
    expect(document.querySelector('[data-testid="credential-editor"]')).toBeNull()
    await click('credential-create')
    expect(node<HTMLInputElement>('credential-label').value).toBe('')
  } finally {
    await act(async () => dispose())
  }
})
