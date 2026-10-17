/** @vitest-environment happy-dom */
import type { PackageInstalledDescriptor } from '@agnes/protocol'
import { homeNavigation } from '@agnes/web-client'
import { expect, it, vi } from 'vitest'
import { confirmEnable } from '../src/admin/plugins/admin/confirms.js'
import { exampleManagement, manageExample } from '../src/admin/plugins/admin/example-parent.js'
import type { PluginAdminPage } from '../src/admin/plugins/admin/page.js'
import { pluginAdminLocaleCatalog } from '../src/admin/plugins/locales/admin.js'

const example = {
  id: 'acme/example',
  metadata: {
    displayName: 'Example',
    description: 'Example',
    summary: 'Example',
    exampleOf: 'acme/parent',
  },
} as PackageInstalledDescriptor
const parent = {
  id: 'acme/parent',
  trusted: true,
  desired: 'enabled',
  actual: 'running',
  blockers: [],
  contributions: [{ kind: 'client', client: { homeEntries: [{ id: 'parent-page' }] } }],
} as unknown as PackageInstalledDescriptor

it.each(['en', 'zh-CN'] as const)(
  'redirects missing/disabled parents to review and active parents to their own page in %s',
  async (locale) => {
    const installed: PackageInstalledDescriptor[] = []
    let pending: Parameters<PluginAdminPage['configureConfirm']>[0] | undefined
    const run = vi.fn(async () => {})
    const page = {
      viewContext: () => ({
        state: { installed, catalog: [] },
        t: (key: string, vars?: Record<string, string | number>) =>
          (pluginAdminLocaleCatalog[locale][key] ?? key).replace('{parent}', String(vars?.parent)),
      }),
      configureConfirm: (value: typeof pending) => {
        pending = value
      },
      chooseUpdateVersion: vi.fn(async () => {}),
      selectTab: vi.fn(async () => {}),
      selectItem: vi.fn(),
    } as unknown as PluginAdminPage
    await confirmEnable(page, example, run)
    expect(exampleManagement(page.viewContext(), example)?.message).toContain(
      locale === 'en' ? 'not installed' : '尚未安装',
    )
    expect(pending).toBeDefined()
    await pending?.run()
    expect(page.chooseUpdateVersion).toHaveBeenCalledWith({ id: parent.id })
    expect(run).not.toHaveBeenCalled()
    installed.push({ ...parent, desired: 'installed-disabled' })
    expect(manageExample(page, example)).toBe(true)
    expect(exampleManagement(page.viewContext(), example)?.message).toContain(
      locale === 'en' ? 'disabled' : '已停用',
    )
    await pending?.run()
    expect(page.selectItem).toHaveBeenCalledWith(installed[0])
    installed[0] = parent
    manageExample(page, example)
    await pending?.run()
    expect(homeNavigation.getSnapshot()).toEqual({ id: 'parent-page', selection: { exampleId: example.id } })
    homeNavigation.close()
  },
)

// Admin review is independent of a session's tool permission preset, including full-access.
it.each([true, false])(
  'requires confirmation before enabling trusted=%s plugins or Skills',
  async (trusted) => {
    let pending: Parameters<PluginAdminPage['configureConfirm']>[0] | undefined
    const run = vi.fn(async () => {})
    const page = {
      viewContext: () => ({
        state: { context: { features: [] }, installed: [], catalog: [] },
        t: (key: string) => key,
      }),
      nameOf: (item: PackageInstalledDescriptor) => item.id,
      configureConfirm: (value: typeof pending) => {
        pending = value
      },
      showError: vi.fn(),
    } as unknown as PluginAdminPage
    await confirmEnable(page, { ...parent, trusted, capabilityHash: 'capability-hash' }, run)
    expect(page.showError).not.toHaveBeenCalled()
    const label = pending?.label
    expect(typeof label === 'function' ? label() : label).toBe(
      trusted ? 'confirm.enable.action' : 'confirm.enable.trust-action',
    )
    expect(run).not.toHaveBeenCalled()
    await pending?.run()
    expect(run).toHaveBeenCalledOnce()
  },
)
