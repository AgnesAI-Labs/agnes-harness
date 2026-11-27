/** @vitest-environment happy-dom */

import type { AdminCredentialMetadata } from '@agnes/protocol/gen/app-server'

import { emptyFeedback, enqueueFeedback, installFeedbackSink, mountRegion, SettingsPage } from '@agnes/web-ui'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { CREDENTIALS_CHANGED, CredentialsPage } from '../src/credentials.js'
import { CredentialError, CredentialsApi, cloudCredentialUsage } from '../src/credentials-api.js'

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
  cloudCredentialUsage.set(undefined)
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

it('creates, replaces and renames write-only credentials; reviews references and confirms forced deletion', async () => {
  let items: AdminCredentialMetadata[] = []
  let referenced = false
  let listUnavailable = false
  let holdListReply: ((response: Response) => Promise<Response>) | undefined
  let replacementResponse: 'refused' | 'lost' | 'saved' = 'refused'
  const feedback = vi.fn()
  const writes: Array<{ path: string; force?: boolean; confirm?: boolean }> = []
  const replacementRequests: Array<{ method?: string; id: unknown; hasValue: boolean }> = []
  const responses: string[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const path = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    let response: Response
    if (path.endsWith('/context')) response = Response.json(context)
    else if (path === '/admin/api/credentials') {
      response = listUnavailable
        ? Response.json({ error: { code: 'E_ADMIN_CATALOG_UNAVAILABLE' } }, { status: 503 })
        : Response.json({ items })
      const hold = holdListReply
      holdListReply = undefined
      if (hold) response = await hold(response)
    } else {
      // Deliberately retain only non-secret request facts, including in failed assertions.
      writes.push({ path, ...(body.force ? { force: body.force, confirm: body.confirm } : {}) })
      if (path.endsWith('/create')) {
        items = [{ ...item, label: body.label }]
        response = Response.json(items[0])
      } else if (path.endsWith('/set')) {
        replacementRequests.push({
          ...(init?.method ? { method: init.method } : {}),
          id: body.id,
          hasValue: body.value === canary,
        })
        if (replacementResponse === 'lost') throw new Error(canary)
        response =
          replacementResponse === 'refused'
            ? Response.json(
                { error: { data: { cause: { code: 'CONFIG_CREDENTIAL_UNAVAILABLE' } } } },
                { status: 503 },
              )
            : Response.json(items[0])
      } else if (path.endsWith('/rename')) {
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
  }
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
  const restoreFeedback = installFeedbackSink({ publish: feedback, resolve: () => {} })
  const changes: unknown[] = []
  const changed = (event: Event) => changes.push((event as CustomEvent).detail)
  window.addEventListener(CREDENTIALS_CHANGED, changed)
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
    expect(changes).toEqual([{ id: item.id, mode: 'create' }])
    const menu = async () => {
      await act(async () => {
        const trigger = node('credential-row').querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!
        trigger.focus()
        trigger.click()
      })
    }
    await menu()
    expect(node('credential-replace')).not.toBeNull()
    await click('credential-replace')
    const replacement = node<HTMLInputElement>('credential-value')
    expect(replacement.type).toBe('password')
    expect(replacement.value).toBe('')
    expect(document.querySelector('[data-testid="credential-label"]')).toBeNull()
    await fill('credential-value', canary)
    feedback.mockClear()
    await click('credential-save')
    expect(node('credential-error').textContent).toContain('unavailable')
    expect(cleanDom()).toBe(true)
    expect(feedback).not.toHaveBeenCalled()
    expect(changes).toHaveLength(1)

    replacementResponse = 'lost'
    await fill('credential-value', canary)
    await click('credential-save')
    expect(feedback.mock.lastCall?.[0]).toMatchObject({
      outcome: 'unknown',
      message: expect.stringContaining('A replacement for Service key could not be confirmed.'),
    })
    expect(cleanDom()).toBe(true)

    replacementResponse = 'saved'
    expect(changes).toHaveLength(1)
    await fill('credential-value', canary)
    await click('credential-save')
    expect(replacementRequests).toEqual([
      { method: 'POST', id: item.id, hasValue: true },
      { method: 'POST', id: item.id, hasValue: true },
      { method: 'POST', id: item.id, hasValue: true },
    ])
    expect(replacement.value === '').toBe(true)
    expect(cleanDom()).toBe(true)
    expect(node('credential-row').dataset.credentialId).toBe(item.id)
    expect(node('credential-row').textContent).toContain(item.label)
    expect(feedback.mock.lastCall?.[0]).toMatchObject({ message: 'Credential value replaced.' })
    expect(feedback.mock.lastCall?.[0]).not.toHaveProperty('effect')
    expect(changes).toEqual([
      { id: item.id, mode: 'create' },
      { id: item.id, mode: 'replace' },
    ])
    await menu()
    await click('credential-rename')
    await fill('credential-label', 'Renamed key')
    await click('credential-save')
    expect(node('credential-row').textContent).toContain('Renamed key')
    expect(changes.at(-1)).toEqual({ id: item.id, mode: 'rename' })
    referenced = true
    await menu()
    await click('credential-delete')
    await click('credential-delete-confirm')
    expect(node('credential-delete-error').textContent).toContain('not deleted')
    await act(async () => window.dispatchEvent(new Event(CREDENTIALS_CHANGED)))
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
    const original = items[0]!.references[0]!
    const added = { kind: 'mcp', profile: 'default', configId: 'service-b' } as const
    const refreshReferences = async (references: AdminCredentialMetadata['references']) => {
      items = [{ ...items[0]!, references }]
      await act(async () => window.dispatchEvent(new Event(CREDENTIALS_CHANGED)))
    }
    listUnavailable = true
    await refreshReferences([original])
    expect(node('credential-delete-refresh-error')?.textContent).toContain('Could not refresh')
    expect(node<HTMLInputElement>('credential-force-confirm').checked).toBe(false)
    expect(node<HTMLInputElement>('credential-force-confirm').disabled).toBe(true)
    expect(node('credential-delete-confirm').textContent).toBe('Delete')
    listUnavailable = false
    await act(async () => node('credential-delete-refresh-error').querySelector('button')?.click())
    expect(node('credential-delete-refresh-error')).toBeNull()
    expect(node<HTMLInputElement>('credential-force-confirm').checked).toBe(false)
    expect(node<HTMLInputElement>('credential-force-confirm').disabled).toBe(false)
    await click('credential-force-confirm')
    let releaseOldList!: () => void
    holdListReply = (response) =>
      new Promise((resolve) => {
        releaseOldList = () => resolve(response)
      })
    await refreshReferences([original])
    expect(node<HTMLInputElement>('credential-force-confirm').disabled).toBe(true)
    await refreshReferences([original, added])
    await act(async () => releaseOldList())
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('service-b')
    expect(node<HTMLInputElement>('credential-force-confirm').checked).toBe(false)
    await refreshReferences([original])
    expect(node<HTMLInputElement>('credential-force-confirm').checked).toBe(false)
    await refreshReferences([original, added])
    await click('credential-force-confirm')
    await refreshReferences([added, original])
    expect(node<HTMLInputElement>('credential-force-confirm').checked).toBe(true)
    items = [{ ...items[0]!, references: [original] }]
    await click('credential-delete-confirm')
    expect(writes.filter((write) => write.path.endsWith('/delete'))).toHaveLength(1)
    expect(node<HTMLInputElement>('credential-force-confirm').checked).toBe(false)
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('service-b')
    await click('credential-force-confirm')
    listUnavailable = true
    await click('credential-delete-confirm')
    expect(writes.filter((write) => write.path.endsWith('/delete'))).toHaveLength(1)
    expect(node('credential-delete-refresh-error')?.textContent).toContain('Could not refresh')
    expect(node<HTMLInputElement>('credential-force-confirm').disabled).toBe(true)
    listUnavailable = false
    await act(async () => node('credential-delete-refresh-error').querySelector('button')?.click())
    expect(node<HTMLInputElement>('credential-force-confirm').checked).toBe(false)
    await click('credential-force-confirm')
    await act(async () => cloudCredentialUsage.set(item.id))
    expect(node<HTMLInputElement>('credential-force-confirm').checked).toBe(false)
    expect(document.querySelector('[role="dialog"]')?.textContent).toMatch(/cloud/i)
    await click('credential-force-confirm')
    await click('credential-delete-confirm')
    expect(writes.at(-1)).toEqual({ path: '/admin/api/credentials/delete', force: true, confirm: true })
    expect(changes.at(-1)).toEqual({ id: item.id, mode: 'delete' })
    expect(document.querySelector('[data-testid="credential-row"]')).toBeNull()
    expect(cleanDom()).toBe(true)
    expect(responses.every((value) => !value.includes(canary))).toBe(true)
  } finally {
    window.removeEventListener(CREDENTIALS_CHANGED, changed)
    restoreFeedback()
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
    expect(node('credential-references').textContent).toContain('Not used')
    await act(async () => cloudCredentialUsage.set(item.id))
    expect(node('credential-references').textContent).toBe('Used by: Cloud connection in this browser')
    await act(async () => cloudCredentialUsage.set('secret://generic/00000000-0000-0000-0000-000000000000'))
    expect(node('credential-references').textContent).toContain('Not used')
    await act(async () => cloudCredentialUsage.set(undefined))
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
  await expect(echo.set(item.id, canary)).rejects.toEqual(new CredentialError('unconfirmed'))
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
  for (const [status, code, reason] of [
    [403, 'E_ADMIN_FORBIDDEN', 'denied'],
    [409, 'E_ADMIN_READ_ONLY', 'readOnly'],
    [409, 'CONFIG_CREDENTIAL_NOT_FOUND', 'missing'],
    [503, 'E_ADMIN_CATALOG_UNAVAILABLE', 'unavailable'],
    [502, 'E_ADMIN_BACKEND', 'unconfirmed'],
    [409, 'CONFIG_CREDENTIAL_STORE', 'unconfirmed'],
  ] as const) {
    const api = new CredentialsApi(async () =>
      Response.json({ error: { data: { cause: { code } }, message: canary } }, { status }),
    )
    await expect(api.set(item.id, canary)).rejects.toEqual(new CredentialError(reason))
  }
  const unreadable = new CredentialsApi(async () => new Response(canary))
  await expect(unreadable.set(item.id, canary)).rejects.toEqual(new CredentialError('unconfirmed'))
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

it('blocks overlapping writes across settings remounts and clears only the deleted credential’s feedback', async () => {
  const metadata: AdminCredentialMetadata = {
    ...item,
    references: [{ kind: 'mcp', profile: 'default', configId: 'service-a' }],
  }
  const other: AdminCredentialMetadata = {
    ...metadata,
    id: 'secret://generic/12345678-1234-1234-1234-123456789013',
    label: 'Other key',
  }
  let items = [metadata, other]
  const writes: { id: string; action: string; reply(response: Response): void }[] = []
  const api = new CredentialsApi(async (input, init) => {
    const path = String(input)
    if (path.endsWith('/context')) return Response.json(context)
    if (path === '/admin/api/credentials') return Response.json({ items })
    const action = path.split('/').at(-1)!
    const { id } = JSON.parse(String(init?.body)) as { id: string }
    const response = await new Promise<Response>((reply) => writes.push({ id, action, reply }))
    if (action === 'delete' && response.ok) items = items.filter((item) => item.id !== id)
    return response
  })
  let feedback = emptyFeedback
  const restore = installFeedbackSink({
    publish: (result) => {
      feedback = enqueueFeedback(feedback, result)
    },
    resolve: (scope) => {
      feedback = { ...feedback, notices: feedback.notices.filter((notice) => notice.scope !== scope) }
    },
  })
  const host = document.body.appendChild(document.createElement('div'))
  let dispose!: () => void
  const mount = () =>
    act(async () => {
      dispose = mountRegion(
        host,
        <SettingsPage title="Permissions & security">
          <CredentialsPage api={api} section />
        </SettingsPage>,
      )
    })
  const menu = async (credential = metadata) => {
    await act(async () => {
      const row = [...document.querySelectorAll<HTMLElement>('[data-testid="credential-row"]')].find(
        (row) => row.dataset.credentialId === credential.id,
      )!
      const actions = row.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!
      actions.focus()
      actions.click()
    })
  }
  const menuItem = (action: string, credential = metadata) =>
    document.querySelector<HTMLElement>(
      `[role="menu"][aria-label="Actions for ${credential.label}"] [data-testid="credential-${action}"]`,
    )!
  const select = (action: string, credential = metadata) =>
    act(async () => menuItem(action, credential).click())
  const closeMenu = () =>
    act(async () => {
      menuItem('replace').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
  const submitAndGoBack = async (credential = metadata) => {
    await menu(credential)
    await select('replace', credential)
    await fill('credential-value', canary)
    await click('credential-save')
    await click('settings-subpage-back')
    await act(async () => window.dispatchEvent(new PopStateEvent('popstate', { state: {} })))
    expect(node('credential-editor')).toBeNull()
    expect(cleanDom()).toBe(true)
    const { reply } = writes.at(-1)!
    return async (response: Response) => act(async () => reply(response))
  }
  const unavailableReply = () => Response.json({ error: { code: 'E_ADMIN_BACKEND' } }, { status: 502 })
  const unknown = () => feedback.notices.find((notice) => notice.outcome === 'unknown')
  await mount()
  try {
    const first = await submitAndGoBack()
    await act(async () => dispose())
    await mount()
    await menu()
    expect(menuItem('replace').getAttribute('aria-disabled')).toBe('true')
    expect(menuItem('delete').getAttribute('aria-disabled')).toBe('true')
    await select('replace')
    await select('delete')
    expect(node('credential-editor')).toBeNull()
    expect(node('credential-delete-confirm')).toBeNull()
    expect(writes).toMatchObject([{ id: metadata.id, action: 'set' }])
    await closeMenu()

    const otherReply = await submitAndGoBack(other)
    await first(unavailableReply())
    const warning = unknown()
    expect(warning?.message).toContain('could not be confirmed')

    const next = await submitAndGoBack()
    await next(Response.json(metadata))
    expect(feedback.queue.at(-1)?.message).toBe('Credential value replaced.')
    expect(feedback.notices.some((notice) => notice.effect?.kind === 'reconnect-required')).toBe(true)
    expect(unknown()).toBe(warning)

    const refused = await submitAndGoBack()
    await refused(Response.json({ error: { code: 'E_ADMIN_FORBIDDEN' } }, { status: 403 }))
    expect(feedback.notices.find((notice) => notice.outcome === 'error')?.message).toContain('permission')
    expect(unknown()).toBe(warning)

    await menu()
    await select('delete')
    await click('credential-force-confirm')
    await click('credential-delete-confirm')
    const deletion = writes.at(-1)!
    expect(deletion).toMatchObject({ id: metadata.id, action: 'delete' })
    expect(node<HTMLButtonElement>('credential-delete-cancel').disabled).toBe(true)

    await otherReply(Response.json(other))
    expect(node<HTMLButtonElement>('credentials-refresh').disabled).toBe(false)
    expect(node<HTMLButtonElement>('credential-delete-cancel').disabled).toBe(true)
    expect(node<HTMLButtonElement>('credential-delete-confirm').disabled).toBe(true)
    expect(node<HTMLInputElement>('credential-force-confirm').disabled).toBe(true)
    await click('credential-delete-cancel')
    expect(node('credential-delete-confirm')).not.toBeNull()
    const reconnectNotices = feedback.notices.filter((notice) => notice.effect?.kind === 'reconnect-required')
    expect(reconnectNotices).toHaveLength(2)
    const otherNotice = reconnectNotices.at(-1)

    await act(async () => dispose())
    await mount()
    await menu()
    expect(menuItem('replace').getAttribute('aria-disabled')).toBe('true')
    await select('replace')
    expect(node('credential-editor')).toBeNull()
    expect(writes.at(-1)).toBe(deletion)
    await act(async () => deletion.reply(Response.json({})))
    expect(
      [...document.querySelectorAll<HTMLElement>('[data-testid="credential-row"]')].map(
        (row) => row.dataset.credentialId,
      ),
    ).toEqual([other.id])
    expect(feedback.notices).toEqual([otherNotice])
    expect(feedback.queue.map((result) => result.message)).toEqual([
      'Credential value replaced.',
      'Credential deleted.',
    ])
  } finally {
    restore()
    await act(async () => dispose())
  }
})
