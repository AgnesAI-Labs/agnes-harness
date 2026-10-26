import {
  preserveRouteParams,
  SETTINGS_ROUTE_EVENT,
  SettingsAccountDialog,
  SettingsModelPane,
  searchParamRoute,
  Toast,
} from '@agnes/web-ui'
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal, flushSync } from 'react-dom'
import { SettingsStaticPane } from './settings-panes.js'
import { createSettingsNavigationStore, SettingsDshHost, SettingsShell } from './settings-shell.js'

export { renderSettingsMarkup } from './settings-fixture.js'

import {
  listedSettingsGroup,
  revealSettingsAnchor,
  type SettingsMoveTarget,
  settingsGroup,
  settingsMoved,
  settingsRoute,
  settingsTabGroup,
} from './settings-navigation.js'

export type SettingsPane = 'model' | 'appearance'
export type SettingsPaneChange = { pane: SettingsPane }

export type SettingsNavigationEntry = {
  id: string
  group: string
  titleKey: string
  groupTitleKey: string
  icon: string
  order: number
  nativePane?: string
  navigationId?: string
}
export interface SettingsRegionOptions {
  sections?: { entries(): readonly SettingsNavigationEntry[]; subscribe(listener: () => void): () => void }
  onChange?: (change: SettingsPaneChange) => void
  onClose?: () => void
  /** A request named a page that moved out of settings; the host opens its new home. */
  onMoved?: (target: SettingsMoveTarget) => void
  /** Locale-bound translate for the React shell and pane controls. */
  translate?: (key: string) => string
  /** What the dialog's own page host shows: the pages of sections without a native pane. */
  sectionPages?: ReactNode
}

export interface SettingsRegionHandle {
  open(pane: SettingsPane): void
  /** The pane currently on screen. */
  active(): SettingsPane
  pane(pane: SettingsPane): HTMLElement | null
  form(): HTMLFormElement | null
}

export const PANE_IDS: Record<SettingsPane, string> = {
  model: 'model-settings-pane',
  appearance: 'appearance-settings-pane',
}

/** The dialog's own page host: sections that have no native pane render here. */
export const SETTINGS_SECTIONS_HOST_ID = 'settings-sections-pane'

/** Where a section shows: its native pane, or the dialog's own section host. */
export function settingsEntryPane(
  entry: Pick<SettingsNavigationEntry, 'nativePane'>,
): SettingsPane | 'sections' {
  return entry.nativePane === 'model' || entry.nativePane === 'appearance' ? entry.nativePane : 'sections'
}

export const SETTINGS_DSH_SLOT_NAMES = Object.freeze([
  'settings.trigger',
  'settings.header',
  'settings.action',
  'settings.close',
  'settings.onboarding',
  'settings.section',
  'settings.general.item',
  'settings.models.provider-card',
  'settings.models.footer',
  'settings.plugins.tab',
  'settings.plugin.item',
] as const)
export type SettingsDshSlotName = (typeof SETTINGS_DSH_SLOT_NAMES)[number]

export const settingsDshSlotHostId = (name: SettingsDshSlotName): string =>
  `settings-dsh-slot-${name.replaceAll('.', '-')}`
const NAV_IDS: Record<SettingsPane, string[]> = {
  model: ['model-settings'],
  appearance: ['appearance-settings'],
}

/** Stable mount point left in the settings shell for one independently replaceable pane row. */
export const settingsPaneSlotHostId = (pane: SettingsPane) => `settings-pane-slot-${pane}`

function SettingsBuiltinImpl(
  { options }: { options: SettingsRegionOptions },
  ref: React.ForwardedRef<SettingsRegionHandle>,
) {
  const host = useRef<HTMLDivElement>(null)
  const activePane = useRef<SettingsPane>('model')
  const [navigation] = useState(() => createSettingsNavigationStore(options.sections?.entries() ?? []))
  const navigateRef = useRef<(id: string, notify?: boolean) => void>()
  const [terminalNotice, setTerminalNotice] = useState<'moved' | 'needs-session' | false>(false)
  const form = useCallback(() => host.current?.querySelector<HTMLFormElement>('#config-form') ?? null, [])
  const open = useCallback(
    (pane: SettingsPane, sections = false): void => {
      if (!sections) activePane.current = pane
      const shell = form()
      if (shell && !shell.dataset.settingsNavigating && !sections) {
        const selected = shell.dataset.settingsSection
        const entry = options.sections?.entries().find((entry) => entry.id === selected)
        if (!entry || settingsEntryPane(entry) !== pane) {
          const first = options.sections?.entries().find((entry) => settingsEntryPane(entry) === pane)
          if (first) navigateRef.current?.(first.id, false)
        }
      }
      const root = host.current
      if (!root) return
      for (const id of Object.values(PANE_IDS))
        root
          .querySelector<HTMLElement>(`#${id}`)
          ?.toggleAttribute('hidden', sections || id !== PANE_IDS[pane])
      root.querySelector<HTMLElement>(`#${SETTINGS_SECTIONS_HOST_ID}`)?.toggleAttribute('hidden', !sections)
      if (sections) return
      for (const [name, ids] of Object.entries(NAV_IDS) as [SettingsPane, string[]][])
        for (const id of ids) {
          const item = root.querySelector<HTMLElement>(`#${id}`)
          // A registry rail entry stands for its whole group; the navigation marks it current.
          if (!item || item.dataset.settingsGroup) continue
          const active = name === pane
          item.classList.toggle('active', active)
          if (active) item.setAttribute('aria-current', 'page')
          else item.removeAttribute('aria-current')
        }
    },
    [form, options.sections],
  )
  useImperativeHandle(
    ref,
    () => ({
      open: (pane) => open(pane),
      active: () => activePane.current,
      pane: (pane) => host.current?.querySelector(`#${PANE_IDS[pane]}`) ?? null,
      form,
    }),
    [form, open],
  )
  const requestedPage = useRef('')
  useLayoutEffect(() => {
    const root = host.current
    if (!root) return
    open('model')
    const listeners: Array<() => void> = []
    const bind = (id: string, change: SettingsPaneChange) => {
      const button = root.querySelector<HTMLButtonElement>(`#${id}`)
      if (!button) return
      const listener = () => {
        open(change.pane)
        options.onChange?.(change)
      }
      button.addEventListener('click', listener)
      listeners.push(() => button.removeEventListener('click', listener))
    }
    if (options.sections) {
      const navigationEntries = () => options.sections?.entries() ?? []
      const tabs = root.querySelector<HTMLElement>('#settings-section-tabs')
      const navigate = (requested: string, notify = true, preserveRoute = false) => {
        const route = settingsRoute(requested)
        const id = route.id
        requestedPage.current = requested
        const tabFocused = tabs?.contains(document.activeElement)
        const entries = navigationEntries()
        const selected = entries.find((entry) => entry.id === id)
        if (!selected && !route.terminal) {
          // The page left settings: hand its new home to the host instead of ignoring the request.
          const moved = settingsMoved(requested) ?? settingsMoved(id)
          if (moved && notify) options.onMoved?.(moved)
          return
        }
        if (route.terminal || !selected) {
          options.onClose?.()
          // Preventing the default acknowledges that the workbench opened the terminal.
          const opened = !root.dispatchEvent(
            new CustomEvent('agnes:settings-terminal', { bubbles: true, cancelable: true }),
          )
          setTerminalNotice(opened ? 'moved' : 'needs-session')
          const url = new URL(location.href)
          url.searchParams.delete('settings')
          history.replaceState(history.state, '', preserveRouteParams(url))
          return
        }
        const address = searchParamRoute('settings')
        const levels = address.read()
        const changeAddress = notify && (levels[0] !== id || (!preserveRoute && levels.length > 1))
        if (changeAddress) history.pushState(null, '', address.href([id]))
        const target = settingsEntryPane(selected)
        const pane = target === 'sections' ? activePane.current : target
        root.dataset.settingsSection = id
        const shell = form()
        if (shell) {
          shell.dataset.settingsSection = id
          shell.dataset.settingsView = notify ? 'detail' : (shell.dataset.settingsView ?? 'list')
          shell.dataset.settingsNavigating = 'true'
        }
        if (!selected.nativePane) {
          root.dataset.runtimePage = id
          if (shell) shell.dataset.runtimePage = id
        }
        open(pane, target === 'sections')
        if (shell) delete shell.dataset.settingsNavigating
        const group = entries.filter((entry) => settingsTabGroup(entry) === settingsTabGroup(selected))
        const panel = root.querySelector(
          `#${target === 'sections' ? SETTINGS_SECTIONS_HOST_ID : PANE_IDS[pane]}`,
        )
        const pageTabs = group.length > 1
        panel?.toggleAttribute('role', false)
        if (pageTabs) {
          panel?.setAttribute('role', 'tabpanel')
          panel?.setAttribute(
            'aria-labelledby',
            selected.nativePane
              ? (selected.navigationId ?? `settings-section-tab-${id}`)
              : `settings-section-tab-${id}`,
          )
        } else panel?.removeAttribute('aria-labelledby')
        for (const button of root.querySelectorAll<HTMLElement>(
          '.settings-nav-group button[data-settings-group]',
        )) {
          const active =
            button.dataset.settingsGroup === settingsGroup(selected.group) &&
            (!listedSettingsGroup(selected.group) || button.dataset.settingsSection === id)
          button.classList.toggle('active', active)
          if (active) button.setAttribute('aria-current', 'page')
          else button.removeAttribute('aria-current')
        }
        if (tabs) {
          const current = navigation.snapshot()
          // The initial layout effect already has this snapshot; later controller events commit
          // synchronously so keyboard focus and controller ID lookups observe the next tabs.
          if (
            current.selected !== id ||
            current.entries.length !== entries.length ||
            current.entries.some((entry, index) => entry !== entries[index])
          )
            flushSync(() => navigation.update({ entries, selected: id }))
        }
        if (notify) {
          if (target !== 'sections') options.onChange?.({ pane })
          if (!selected.nativePane)
            root.dispatchEvent(new CustomEvent('agnes:settings-page', { detail: id, bubbles: true }))
        }
        if (changeAddress) window.dispatchEvent(new Event(SETTINGS_ROUTE_EVENT))
        if (route.anchor)
          requestAnimationFrame(() => {
            const anchor = route.anchor ?? ''
            // Once its subsection is on screen the link is spent: a later route to this page (a
            // back step, the hub's echo) is the page itself and must not open the subsection again.
            if (document.getElementById(anchor) && requestedPage.current === requested)
              requestedPage.current = id
            revealSettingsAnchor(anchor)
          })
        if (notify && !tabFocused && window.matchMedia('(max-width: 767px)').matches)
          root.querySelector<HTMLButtonElement>('#settings-back')?.focus({ preventScroll: true })
        if (tabFocused)
          tabs?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus({ preventScroll: true })
      }
      navigateRef.current = navigate
      const back = root.querySelector<HTMLButtonElement>('#settings-back')
      const onBack = () => {
        const shell = form()
        if (shell) shell.dataset.settingsView = 'list'
        root
          .querySelector<HTMLButtonElement>('.settings-nav-group [aria-current="page"]')
          ?.focus({ preventScroll: true })
      }
      back?.addEventListener('click', onBack)
      listeners.push(() => {
        back?.removeEventListener('click', onBack)
        navigateRef.current = undefined
      })
      const onClick = (event: Event) => {
        const target = (event.target as Element | null)?.closest<HTMLElement>(
          'button[data-settings-section], a[href]',
        )
        if (target?.dataset.settingsSection) {
          navigate(target.dataset.settingsSection)
          return
        }
        if (!(target instanceof HTMLAnchorElement) || !(event instanceof MouseEvent)) return
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          event.defaultPrevented ||
          (target.target !== '' && target.target !== '_self')
        )
          return
        const url = new URL(target.href, location.href)
        if (url.origin !== location.origin) return
        const id = url.searchParams.get('settings')
        if (!id) return
        event.preventDefault()
        history.pushState(null, '', url)
        const page = searchParamRoute('settings').read()[0]
        if (page) navigate(page, true, true)
        window.dispatchEvent(new Event(SETTINGS_ROUTE_EVENT))
        if (url.hash.length <= 1) return
        let fragment: string
        try {
          fragment = decodeURIComponent(url.hash.slice(1))
        } catch {
          return
        }
        // The target may sit in a fold: open what encloses it, then bring it into view.
        requestAnimationFrame(() => revealSettingsAnchor(fragment))
      }
      const onRoute = (event: Event) => {
        const id = String((event as CustomEvent).detail)
        // The embedded hub echoes its canonical page after mounting. Keep the
        // requested subsection through that echo.
        const requested = requestedPage.current
        const linked = settingsRoute(requested)
        navigate(linked.id === id && linked.anchor ? requested : id, true, true)
      }
      const onKeys = (event: KeyboardEvent) => {
        const target = event.target as HTMLElement
        const modal = root.closest<HTMLDialogElement>('dialog')
        if (!root.contains(target) && !modal?.open) return
        if (target.closest?.('dialog') && target.closest('dialog') !== modal) return
        if (target.getAttribute('role') !== 'tab' || !tabs?.contains(target)) return
        const choices = [...tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        const index = choices.indexOf(target as HTMLButtonElement)
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? choices.length - 1
              : ['ArrowRight', 'ArrowDown'].includes(event.key)
                ? (index + 1) % choices.length
                : ['ArrowLeft', 'ArrowUp'].includes(event.key)
                  ? (index - 1 + choices.length) % choices.length
                  : -1
        if (next < 0) return
        event.preventDefault()
        const id = choices[next]?.dataset.settingsSection
        if (id) {
          navigate(id)
          tabs.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus()
        }
      }
      root.addEventListener('click', onClick)
      root.addEventListener('agnes:settings-route', onRoute)
      document.addEventListener('keydown', onKeys)
      listeners.push(() => {
        root.removeEventListener('click', onClick)
        root.removeEventListener('agnes:settings-route', onRoute)
        document.removeEventListener('keydown', onKeys)
      })
      const syncEntries = () => {
        const rail = root.querySelector<HTMLElement>('.settings-rail')
        if (!rail) return
        const focused = root.querySelector<HTMLButtonElement>('button[data-settings-section]:focus')
        const focusedSection = focused?.dataset.settingsSection
        const tabFocused = focused && tabs?.contains(focused)
        const entries = navigationEntries()
        // React reconciles the navigation while retaining native controls and outlets.
        flushSync(() => navigation.update({ entries, selected: root.dataset.settingsSection ?? 'model' }))
        const selected = root.dataset.settingsSection ?? 'model'
        const present = entries.some((entry) => entry.id === selected)
        navigate(present ? selected : 'model', !present)
        if (focused) {
          const target = tabFocused
            ? tabs?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
            : rail.querySelector<HTMLButtonElement>(`button[data-settings-section="${focusedSection}"]`)
          ;(target ?? rail.querySelector<HTMLButtonElement>('[aria-current="page"]'))?.focus({
            preventScroll: true,
          })
        }
      }
      listeners.push(options.sections.subscribe(syncEntries))
      navigate('model', false)
    } else {
      bind('model-settings', { pane: 'model' })
      bind('appearance-settings', { pane: 'appearance' })
    }
    const close = root.querySelector<HTMLButtonElement>('#config-close')
    if (close) {
      const listener = () => options.onClose?.()
      close.addEventListener('click', listener)
      listeners.push(() => close.removeEventListener('click', listener))
    }
    return () => {
      for (const dispose of listeners) dispose()
    }
  }, [form, open, options, navigation])
  return (
    <div ref={host}>
      <div>
        <SettingsShell
          store={options.sections ? navigation : undefined}
          translate={options.translate}
          sectionPages={options.sectionPages}
        />
      </div>
      <SettingsAccountDialog {...(options.translate ? { t: options.translate } : {})} />
      {createPortal(
        <Toast tone="info" open={!!terminalNotice} onDismiss={() => setTerminalNotice(false)}>
          {terminalNotice === 'needs-session'
            ? (options.translate?.('settings-shell.terminalNeedsSession') ??
              'Open a session to use the terminal.')
            : (options.translate?.('settings-shell.terminalMoved') ??
              'The terminal is now in the session workbench.')}
        </Toast>,
        document.body,
      )}
    </div>
  )
}

export const SettingsBuiltin = forwardRef(SettingsBuiltinImpl)

/** One independently mounted settings contribution. Its lifetime is owned by the corresponding row. */
export function SettingsPaneBuiltin({
  pane,
  translate,
  extras,
}: {
  translate?: (key: string) => string
  pane: SettingsPane
  /** More groups for the General page, owned by the host: they sit above the advanced switch. */
  extras?: ReactNode
}) {
  return (
    <div data-agnes-region-owner="builtin" data-agnes-region-unit={`settings-${pane}`}>
      {pane === 'model' ? (
        <SettingsModelPane
          {...(translate ? { t: translate } : {})}
          beforeAccounts={<SettingsDshHost name="settings.models.provider-card" />}
          afterAccounts={<SettingsDshHost name="settings.models.footer" />}
        />
      ) : (
        <SettingsStaticPane pane={pane} extras={extras} {...(translate ? { translate } : {})} />
      )}
    </div>
  )
}
