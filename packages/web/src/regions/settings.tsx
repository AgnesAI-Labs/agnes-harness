import {
  dshSlotSpec,
  type LocaleService,
  SlotOutlet,
  type SlotRegistry,
  SlotsProvider,
} from '@agnes/web-client'
import type { AntdRoot } from '@agnes/web-ui'
import { createAntdRoot } from '@agnes/web-ui'
import {
  PANE_IDS,
  SETTINGS_DSH_SLOT_NAMES,
  SettingsBuiltin,
  type SettingsPane,
  SettingsPaneBuiltin,
  type SettingsPaneChange,
  type SettingsRegionHandle,
  settingsDshSlotHostId,
  settingsPaneSlotHostId,
} from '@agnes/web-units'
import type { ReactNode } from 'react'
import { flushSync } from 'react-dom'
import {
  type EmptyStateRegionMount,
  SETTINGS_DSH_GLOBAL_SLOT_NAMES,
  SETTINGS_UNIT_OWNER,
  settingsPaneSlot,
} from './contracts.js'

export interface SettingsRegionOptions {
  sections?: import('@agnes/web-client').UiExtensionRegistry<import('@agnes/web-client').SettingsSection>

  computerUseSupported?: () => Promise<boolean>
  computerUse?: ReactNode
  onChange?: (change: SettingsPaneChange) => void
  onClose?: () => void
}

export interface SettingsRegionMount extends EmptyStateRegionMount, SettingsRegionHandle {
  /** Remove exactly one built-in pane without disturbing its siblings or the settings shell. */
  unmountPane(pane: SettingsPane): void
}

/** The settings dialog is component-owned; the dialog shell remains the skin/accessibility boundary. */
export function mountSettingsPaneRegion(
  registry: SlotRegistry,
  container: HTMLElement,
  options: SettingsRegionOptions = {},
  locale?: LocaleService,
): SettingsRegionMount {
  // The dialog/rail is a host scaffold. Every page below it is a separate row and separate
  // SlotOutlet, so disabling a single built-in or third-party replacement cannot reset siblings.
  for (const pane of Object.keys(PANE_IDS) as SettingsPane[])
    registry.declare(settingsPaneSlot(pane) as string, { kind: 'single', scope: 'root' }, 'web-shell')
  for (const name of SETTINGS_DSH_SLOT_NAMES) {
    const spec = dshSlotSpec(name)
    if (!spec) throw new Error(`settings DSH slot is missing from the catalog: ${name}`)
    registry.declare(name, spec, 'web-shell')
  }
  const handle = { current: null as SettingsRegionHandle | null }
  const root = createAntdRoot(container)
  const shellOptions = locale ? { ...options, translate: (key: string) => locale.t(key) } : options
  const renderSettingsShell = (): void => {
    flushSync(() => root.render(<SettingsBuiltin ref={handle} options={shellOptions} />))
  }
  renderSettingsShell()
  const dshRoots = new Map<string, AntdRoot>()
  const dshPaneSlots = new Map<SettingsPane, string[]>()
  const mountDshOutlet = (name: string, host: HTMLElement, pane?: SettingsPane): void => {
    if (dshRoots.has(name)) throw new Error(`settings DSH slot is mounted twice: ${name}`)
    const dshRoot = createAntdRoot(host)
    dshRoots.set(name, dshRoot)
    if (pane) dshPaneSlots.set(pane, [...(dshPaneSlots.get(pane) ?? []), name])
    flushSync(() => {
      dshRoot.render(
        <SlotsProvider registry={registry}>
          <SlotOutlet name={name as never} hideWhenEmpty />
        </SlotsProvider>,
      )
    })
  }
  for (const name of SETTINGS_DSH_GLOBAL_SLOT_NAMES) {
    const host = container.querySelector<HTMLElement>(`#${settingsDshSlotHostId(name as never)}`)
    if (!host) throw new Error(`settings shell is missing ${name}`)
    mountDshOutlet(name, host)
  }
  const paneRoots = new Map<SettingsPane, AntdRoot>()
  const removeBuiltin = new Map<SettingsPane, () => void>()
  for (const pane of Object.keys(PANE_IDS) as SettingsPane[]) {
    const slotHost = container.querySelector<HTMLElement>(`#${settingsPaneSlotHostId(pane)}`)
    if (!slotHost) throw new Error(`settings shell is missing ${settingsPaneSlotHostId(pane)}`)
    const paneRoot = createAntdRoot(slotHost)
    paneRoots.set(pane, paneRoot)
    const remove = registry.register(
      {
        name: settingsPaneSlot(pane) as string,
        id: `builtin-settings-${pane}`,
        owner: SETTINGS_UNIT_OWNER[pane],
        priority: 0,
      },
      () => (
        <SettingsPaneBuiltin
          pane={pane}
          computerUse={options.computerUse}
          {...(locale ? { translate: (key: string) => locale.t(key) } : {})}
        />
      ),
    )
    removeBuiltin.set(pane, remove)
    flushSync(() => {
      paneRoot.render(
        <SlotsProvider registry={registry}>
          <SlotOutlet name={settingsPaneSlot(pane)} />
        </SlotsProvider>,
      )
    })
    for (const name of SETTINGS_DSH_SLOT_NAMES) {
      if (SETTINGS_DSH_GLOBAL_SLOT_NAMES.has(name)) continue
      const dshHost = slotHost.querySelector<HTMLElement>(`#${settingsDshSlotHostId(name as never)}`)
      if (!dshHost) continue
      mountDshOutlet(name, dshHost, pane)
    }
  }
  // JSX reconciliation retains controller-bound elements and nested DSH root hosts on locale changes.
  const stopLocaleUpdates = locale?.subscribe(() => {
    renderSettingsShell()
    for (const [pane, paneRoot] of paneRoots) {
      flushSync(() =>
        paneRoot.render(
          <SlotsProvider registry={registry}>
            <SlotOutlet name={settingsPaneSlot(pane)} />
          </SlotsProvider>,
        ),
      )
    }
  })
  let disposed = false
  return {
    open(pane: SettingsPane) {
      handle.current?.open(pane)
    },
    pane(pane: SettingsPane) {
      return handle.current?.pane(pane) ?? null
    },
    form() {
      return handle.current?.form() ?? null
    },
    unmountPane(pane) {
      for (const name of dshPaneSlots.get(pane) ?? []) {
        dshRoots.get(name)?.unmount()
        dshRoots.delete(name)
      }
      dshPaneSlots.delete(pane)
      removeBuiltin.get(pane)?.()
      removeBuiltin.delete(pane)
      paneRoots.get(pane)?.unmount()
      paneRoots.delete(pane)
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const pane of Object.keys(PANE_IDS) as SettingsPane[]) this.unmountPane(pane)
      for (const [name, dshRoot] of dshRoots) {
        dshRoot.unmount()
        dshRoots.delete(name)
      }
      stopLocaleUpdates?.()
      root.unmount()
    },
  }
}
