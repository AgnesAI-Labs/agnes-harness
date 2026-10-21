/** @vitest-environment happy-dom */
import type { ApplicationState } from '@agnes/protocol'
import { renderRegion, unmountRegion } from '@agnes/web-ui'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { Recovery } from '../src/recovery.js'

const admin = vi.hoisted(() => {
  const context = vi.fn()
  const application = vi.fn()
  const clearApplication = vi.fn()
  // The page renders once when it is imported; settle that first read before the cases drive their own.
  context.mockResolvedValue({ profile: 'local-dev', clientId: 'web', permissions: [], readOnly: false })
  application.mockResolvedValue({
    revision: 0,
    status: 'host',
    selection: null,
    effective: null,
    assets: {},
    candidates: [],
  })
  return { context, application, clearApplication }
})

vi.mock('@agnes/web-admin/admin/plugins/api', () => ({
  PluginAdminApi: class {
    static context = admin.context
    application = admin.application
    clearApplication = admin.clearApplication
  },
}))

const readFailure = 'Recovery is unavailable. Check that the backend is running, then retry.'
const clearFailure = 'The selection changed or could not be cleared. Read it again and retry.'

const selection: NonNullable<ApplicationState['selection']> = {
  packageId: '@community/deliverables-gallery',
  applicationId: 'deliverables-gallery',
  integrity: 'sha256-gallery',
  declarationDigest: 'a'.repeat(64),
  consentDigest: 'b'.repeat(64),
  bindingDigest: 'c'.repeat(64),
}
const roleSelection: NonNullable<NonNullable<ApplicationState['roleSelections']>['deliverables']> = {
  packageId: selection.packageId,
  clientId: 'gallery',
  integrity: selection.integrity,
  declarationDigest: selection.declarationDigest,
  consentDigest: selection.consentDigest,
  bindingDigest: selection.bindingDigest,
}
const hostState: ApplicationState = {
  revision: 1,
  status: 'host',
  selection: null,
  effective: null,
  assets: {},
  candidates: [],
}
const activeState: ApplicationState = {
  revision: 2,
  status: 'active',
  selection,
  effective: null,
  assets: {},
  candidates: [],
}

const bodyText = () => document.body.textContent ?? ''
const button = (label: string) =>
  [...document.body.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)

beforeAll(async () => {
  await vi.waitFor(() => expect(admin.application).toHaveBeenCalled())
})
beforeEach(() => {
  document.documentElement.lang = 'en'
  vi.resetAllMocks()
  admin.context.mockResolvedValue({
    profile: 'local-dev',
    clientId: 'web',
    permissions: [],
    readOnly: false,
  })
  admin.application.mockResolvedValue(hostState)
})
afterEach(() => {
  unmountRegion(document.body)
  document.body.replaceChildren()
})

it('shows the reason and retries the read after a failed load', async () => {
  admin.application.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(hostState)
  renderRegion(document.body, <Recovery />)
  await vi.waitFor(() => expect(bodyText()).toContain(readFailure))
  expect(admin.context).toHaveBeenCalledTimes(1)
  expect(button('Retry')).toBeDefined()
  expect(document.title).toBe('Application recovery · Agnes Harness')
  expect(document.querySelector('h1')?.textContent).toBe('Application recovery')
  expect(bodyText()).toContain('agh app clear')
  button('Retry')?.click()
  await vi.waitFor(() => expect(bodyText()).toContain('No application selected'))
  expect(admin.context).toHaveBeenCalledTimes(2)
  expect(bodyText()).not.toContain(readFailure)
})

it('disables the restore action when the official interface is already in use', async () => {
  renderRegion(document.body, <Recovery />)
  await vi.waitFor(() =>
    expect(button('Restore official interface')?.title).toBe('The official interface is already in use.'),
  )
  expect(button('Restore official interface')?.disabled).toBe(true)
  expect(document.querySelector('.agnes-settings-tag')?.textContent).toBe('Official interface')
})

it('restores the official interface and keeps the result on the page', async () => {
  admin.application.mockResolvedValue(activeState)
  admin.clearApplication.mockResolvedValue({ ...hostState, revision: 3 })
  renderRegion(document.body, <Recovery />)
  await vi.waitFor(() => expect(button('Restore official interface')?.disabled).toBe(false))
  button('Restore official interface')?.click()
  await vi.waitFor(() => expect(bodyText()).toContain('Official interface restored.'))
  expect(admin.clearApplication).toHaveBeenCalledWith(activeState.revision)
  expect(button('Restore official interface')?.disabled).toBe(true)
  expect(document.querySelector('.agnes-settings-tag')?.textContent).toBe('Official interface')
})

it('offers a re-read when the selection changed before clearing', async () => {
  admin.application.mockResolvedValue(activeState)
  admin.clearApplication.mockRejectedValueOnce(new Error('conflict'))
  renderRegion(document.body, <Recovery />)
  await vi.waitFor(() => expect(button('Restore official interface')?.disabled).toBe(false))
  button('Restore official interface')?.click()
  await vi.waitFor(() => expect(bodyText()).toContain(clearFailure))
  // The read state stays visible; only the action is held back until the re-read finishes.
  expect(bodyText()).toContain(selection.packageId)
  expect(button('Restore official interface')?.disabled).toBe(true)
  admin.application.mockResolvedValue({ ...hostState, revision: 4 })
  button('Read again')?.click()
  await vi.waitFor(() => expect(bodyText()).toContain('No application selected'))
  expect(admin.application).toHaveBeenCalledTimes(2)
  expect(bodyText()).not.toContain(clearFailure)
})

it('keeps the restore action available when only interface roles were chosen', async () => {
  admin.application.mockResolvedValue({
    revision: 4,
    status: 'active',
    selection: null,
    effective: null,
    assets: {},
    candidates: [],
    roleSelections: { deliverables: roleSelection },
  })
  renderRegion(document.body, <Recovery />)
  await vi.waitFor(() => expect(button('Restore official interface')?.disabled).toBe(false))
  expect(bodyText()).toContain('No application selected')
  expect(bodyText()).toContain('1 role override')
})

it('shows the reason a selected interface could not be loaded', async () => {
  admin.application.mockResolvedValue({
    revision: 5,
    status: 'unresolved',
    selection,
    reason: 'declaration digest does not match the installed package',
    effective: null,
    assets: {},
    candidates: [],
  })
  renderRegion(document.body, <Recovery />)
  await vi.waitFor(() =>
    expect(bodyText()).toContain('declaration digest does not match the installed package'),
  )
  expect(document.querySelector('.agnes-settings-tag')?.textContent).toBe('Not loaded')
  expect(button('Restore official interface')?.disabled).toBe(false)
})
