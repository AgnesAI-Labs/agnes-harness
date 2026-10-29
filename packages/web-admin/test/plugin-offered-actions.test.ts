import type { PackageInstalledDescriptor } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { offeredActions } from '../src/admin/plugins/admin/confirms.js'
import type { PluginAdminPage } from '../src/admin/plugins/admin/page.js'
import { projectedStatusAction } from '../src/admin/plugins/admin/status-action.js'

const actions = [
  { label: 'Check for updates', group: 'versions', className: '', onClick: () => undefined },
  { label: 'Revoke trust', group: 'trust', className: '', onClick: () => undefined },
  { label: 'Uninstall', group: 'versions', danger: true, className: '', onClick: () => undefined },
]
const page = { detailActions: () => actions } as unknown as PluginAdminPage
const plugin = (ref: string, origin: string) =>
  ({
    id: '@agnes/skill-helper',
    source: { type: 'file', ref },
    presentation: { origin, rows: [] },
  }) as unknown as PackageInstalledDescriptor

it('never offers to uninstall what ships with the product, and keeps its other actions', () => {
  for (const name of ['skill-helper', 'mcp-helper', 'plugin-helper', 'document-reader']) {
    const offered = offeredActions(page)({
      ...plugin(`file:./bundled-plugins/${name}`, 'official'),
      id: `@agnes/${name}`,
    })
    expect(offered.map((action) => action.label)).toEqual(['Check for updates', 'Revoke trust'])
  }
})

it('offers uninstall for an optional bundled package but not for a default helper', () => {
  const optional = {
    ...plugin('file:./bundled-plugins/jev-loop', 'official'),
    id: '@agnes/jev-loop',
    presentation: { origin: 'official', optional: true, rows: [] },
  } as unknown as PackageInstalledDescriptor
  expect(offeredActions(page)(optional).map((action) => action.label)).toEqual([
    'Check for updates',
    'Revoke trust',
    'Uninstall',
  ])
  expect(
    offeredActions(page)(plugin('file:./bundled-plugins/skill-helper', 'official')).map(
      (action) => action.label,
    ),
  ).not.toContain('Uninstall')
})

it('offers every action for a plugin the user installed', () => {
  expect(offeredActions(page)(plugin('file:./my-plugins/skill-helper', 'local-source'))).toHaveLength(3)
  expect(offeredActions(page)(plugin('npm:@agnes/skill-helper@1.0.0', 'official'))).toHaveLength(3)
})

it('offers no ordinary management actions for any parent-owned example', () => {
  const example = {
    ...plugin('file:./example', 'example'),
    metadata: {
      displayName: 'Example',
      summary: 'Example',
      description: 'Example',
      exampleOf: 'acme/parent',
    },
  }
  expect(offeredActions(page)(example)).toEqual([])
  expect(
    offeredActions(page)({
      ...example,
      metadata: { displayName: 'FDE', summary: 'FDE', description: 'FDE' },
      agents: [
        {
          ref: 'acme/kit#work',
          launch: { title: { en: 'Work' }, description: { en: 'Work' }, preset: 'safe' },
        },
      ],
    }),
  ).toHaveLength(3)
})

it('keeps projected trust/enable actions inside the existing permission and confirmation boundary', async () => {
  let allowed = false
  let confirmed = false
  const item = {
    ...plugin('file:./plugin', 'local-source'),
    trusted: false,
    capabilityHash: 'a'.repeat(64),
    primaryStatus: {
      state: 'untrusted',
      reasonCode: 'trust-required',
      nextAction: 'trust',
      reason: { en: 'Review trust.', 'zh-CN': '审阅信任。' },
    },
  } as PackageInstalledDescriptor
  const owner = {
    viewContext: () => ({ t: (key: string) => key, canEffect: () => allowed, packageBusy: () => false }),
    confirmEnable: async () => {
      confirmed = true
    },
  } as unknown as PluginAdminPage
  expect(projectedStatusAction(owner, item)?.disabled).toBe(true)
  expect(confirmed).toBe(false)
  allowed = true
  const action = projectedStatusAction(owner, item)
  expect(action?.disabled).toBe(false)
  await action?.run()
  expect(confirmed).toBe(true)
})

it('opens restart guidance without claiming or dispatching a restart', async () => {
  let confirmation: { description(): string; run(): Promise<void> } | undefined
  const item = {
    ...plugin('file:./plugin', 'local-source'),
    primaryStatus: {
      state: 'restart-required',
      reasonCode: 'restart-required',
      nextAction: 'restart',
      reason: { en: 'Restart.', 'zh-CN': '请重启。' },
    },
  } as PackageInstalledDescriptor
  const owner = {
    viewContext: () => ({ t: (key: string) => key, packageBusy: () => false }),
    configureConfirm: (value: typeof confirmation) => {
      confirmation = value
    },
  } as unknown as PluginAdminPage
  await projectedStatusAction(owner, item)?.run()
  expect(confirmation?.description()).toBe('status.restartHelp')
  await expect(confirmation?.run()).resolves.toBeUndefined()
})
