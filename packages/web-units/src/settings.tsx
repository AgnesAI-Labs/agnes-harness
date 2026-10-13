import { SettingsAccountDialog, SettingsModelPane, Toast } from '@agnes/web-ui'
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
import type { AdminPaneStore } from './admin-pane-store.js'
import { SettingsStaticPane } from './settings-panes.js'
import { createSettingsNavigationStore, SettingsDshHost, SettingsShell } from './settings-shell.js'

export { renderSettingsMarkup } from './settings-fixture.js'

import {
  advancedSettings,
  matchesSettings,
  revealSettingsAnchor,
  settingsGroup,
  settingsRoute,
} from './settings-navigation.js'

export type SettingsPane = 'model' | 'plugin' | 'resources' | 'archived' | 'computer-use' | 'appearance'
export type SettingsResourceTab = 'skills' | 'mcp'
export type SettingsPaneChange = { pane: SettingsPane; tab?: SettingsResourceTab }

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
  /** Load state of the plugin and Skill / MCP panes, written by their controller. */
  adminPanes?: AdminPaneStore

  /** Host capability probe; a failed probe keeps the diagnostic entry available. */
  computerUseSupported?: () => Promise<boolean>
  onChange?: (change: SettingsPaneChange) => void
  onClose?: () => void
  /** Locale-bound translate for the React shell and pane controls. */
  translate?: (key: string) => string
}

export interface SettingsRegionHandle {
  open(pane: SettingsPane): void
  pane(pane: SettingsPane): HTMLElement | null
  form(): HTMLFormElement | null
}

export const PANE_IDS: Record<SettingsPane, string> = {
  model: 'model-settings-pane',
  plugin: 'plugin-settings-pane',
  resources: 'resource-settings-pane',
  archived: 'archived-settings-pane',
  'computer-use': 'computer-use-settings-pane',
  appearance: 'appearance-settings-pane',
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
  plugin: ['plugin-management'],
  resources: ['skills-tab', 'mcp-tab'],
  archived: ['archived-settings'],
  'computer-use': ['computer-use-management'],
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
    (pane: SettingsPane): void => {
      activePane.current = pane
      const shell = form()
      if (shell && !shell.dataset.settingsNavigating) {
        const selected = shell.dataset.settingsSection
        const entry = options.sections?.entries().find((entry) => entry.id === selected)
        if ((entry?.nativePane ?? 'plugin') !== pane || !selected) {
          const first = options.sections?.entries().find((entry) => (entry.nativePane ?? 'plugin') === pane)
          if (first) navigateRef.current?.(first.id, false)
        }
      }
      const root = host.current
      if (!root) return
      for (const id of Object.values(PANE_IDS))
        root.querySelector<HTMLElement>(`#${id}`)?.toggleAttribute('hidden', id !== PANE_IDS[pane])
      for (const [name, ids] of Object.entries(NAV_IDS) as [SettingsPane, string[]][])
        for (const id of ids) {
          const item = root.querySelector<HTMLElement>(`#${id}`)
          // A registry rail entry stands for its whole group; the navigation marks it current.
          if (!item || item.dataset.settingsGroup) continue
          const active =
            name === pane &&
            (pane !== 'resources' || item.getAttribute('aria-selected') === 'true') &&
            (pane !== 'plugin' || (root.dataset.runtimePage ?? 'plugins') === 'plugins')
          item.classList.toggle('active', active)
          if (active) item.setAttribute('aria-current', 'page')
          else item.removeAttribute('aria-current')
        }
      for (const item of root.querySelectorAll<HTMLElement>('[data-runtime-page]')) {
        const active =
          pane === 'plugin' && item.dataset.runtimePage === (root.dataset.runtimePage ?? 'plugins')
        item.classList.toggle('active', active)
        if (active) item.setAttribute('aria-current', 'page')
        else item.removeAttribute('aria-current')
      }
      if (pane === 'resources') {
        const list = root.querySelector<HTMLElement>('#resource-list')
        const selected = root.querySelector<HTMLButtonElement>('.settings-nav-tabs [aria-selected="true"]')
        list?.setAttribute('role', 'tabpanel')
        if (selected) list?.setAttribute('aria-labelledby', selected.id)
      }
    },
    [form, options.sections],
  )
  useImperativeHandle(
    ref,
    () => ({ open, pane: (pane) => host.current?.querySelector(`#${PANE_IDS[pane]}`) ?? null, form }),
    [form, open],
  )
  useLayoutEffect(() => {
    const root = host.current
    if (!root) return
    open('model')
    const listeners: Array<() => void> = []
    // The shell owns visibility. A replacement Computer Use row starts hidden, so restore
    // the current navigation choice when that row returns without another navigation click.
    let computerUsePane = root.querySelector('#computer-use-settings-pane')
    const observer = new MutationObserver(() => {
      const next = root.querySelector('#computer-use-settings-pane')
      if (next === computerUsePane) return
      computerUsePane = next
      open(activePane.current)
    })
    observer.observe(root, { childList: true, subtree: true })
    listeners.push(() => observer.disconnect())
    const bind = (id: string, change: SettingsPaneChange) => {
      const button = root.querySelector<HTMLButtonElement>(`#${id}`)
      if (!button) return
      const listener = () => {
        open(change.pane)
        options.onChange?.(change)
      }
      button.addEventListener('click', listener)
      listeners.push(() => button.removeEventListener('click', listener))
      if (change.tab) {
        const onKeydown = (event: KeyboardEvent) => {
          let next: SettingsResourceTab | undefined
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key))
            next = change.tab === 'skills' ? 'mcp' : 'skills'
          if (event.key === 'Home') next = 'skills'
          if (event.key === 'End') next = 'mcp'
          if (!next) return
          const target = root.querySelector<HTMLButtonElement>(`#${next}-tab`)
          if (!target || target.disabled) return
          event.preventDefault()
          target.focus({ preventScroll: true })
          if (next !== change.tab) target.click()
        }
        button.addEventListener('keydown', onKeydown)
        listeners.push(() => button.removeEventListener('keydown', onKeydown))
      }
    }
    if (options.sections) {
      let computerUseSupported = true
      const navigationEntries = () => {
        const entries = options.sections?.entries() ?? []
        return computerUseSupported ? entries : entries.filter((entry) => entry.id !== 'computer-use')
      }
      const tabs = root.querySelector<HTMLElement>('#settings-section-tabs')
      const search = root.querySelector<HTMLInputElement>('#settings-search')
      let advanced = root.querySelector<HTMLDetailsElement>('#settings-advanced')
      let searchWasAdvanced = false
      const filter = () => {
        const query = search?.value.trim() ?? ''
        if (query && !root.dataset.settingsSearching) searchWasAdvanced = advanced?.open ?? false
        const wasSearching = !!root.dataset.settingsSearching
        root.dataset.settingsSearching = query ? 'true' : ''
        let count = 0
        const entries = navigationEntries()
        for (const button of root.querySelectorAll<HTMLButtonElement>(
          '.settings-nav-group button[data-settings-group]',
        )) {
          const group = entries.filter((entry) => settingsGroup(entry.group) === button.dataset.settingsGroup)
          const choices =
            button.dataset.settingsGroup === 'extensions'
              ? group.filter((entry) => entry.id === button.dataset.settingsSection)
              : group
          const match = choices.find((entry) =>
            matchesSettings(
              query,
              [entry.titleKey, entry.groupTitleKey, `settings-shell.keywords.${settingsGroup(entry.group)}`]
                .map((key) => options.translate?.(key) ?? key)
                .join(' '),
            ),
          )
          button.hidden = !match
          if (match) count++
        }
        if (advanced) {
          if (query) advanced.open = true
          else if (wasSearching) advanced.open = searchWasAdvanced
          advanced.hidden = ![...advanced.querySelectorAll<HTMLButtonElement>('button')].some(
            (button) => !button.hidden,
          )
        }
        root.querySelector('#settings-search-empty')?.toggleAttribute('hidden', count > 0)
      }
      const navigate = (requested: string, notify = true) => {
        const route = settingsRoute(requested)
        let id = route.id
        const tabFocused = tabs?.contains(document.activeElement)
        const entries = navigationEntries()
        const selected =
          entries.find((entry) => entry.id === id) ??
          (id === 'computer-use' ? entries.find((entry) => entry.id === 'mcp') : undefined)
        if (!selected) return
        id = selected.id
        if (route.terminal) {
          options.onClose?.()
          // Preventing the default acknowledges that the workbench opened the terminal.
          const opened = !root.dispatchEvent(
            new CustomEvent('agnes:settings-terminal', { bubbles: true, cancelable: true }),
          )
          setTerminalNotice(opened ? 'moved' : 'needs-session')
          const url = new URL(location.href)
          url.searchParams.delete('settings')
          history.replaceState(history.state, '', url)
          return
        }
        const pane = (selected.nativePane ?? 'plugin') as SettingsPane
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
        open(pane)
        if (shell) delete shell.dataset.settingsNavigating
        const group = entries.filter((entry) => settingsGroup(entry.group) === settingsGroup(selected.group))
        const panel = root.querySelector(`#${PANE_IDS[pane]}`)
        const pageTabs = group.length > 1 && settingsGroup(selected.group) !== 'extensions'
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
            (button.dataset.settingsGroup !== 'extensions' || button.dataset.settingsSection === id)
          button.classList.toggle('active', active)
          if (active) button.setAttribute('aria-current', 'page')
          else button.removeAttribute('aria-current')
        }
        if (notify && advancedSettings(selected.group) && advanced) advanced.open = true
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
        if (pane === 'resources')
          root
            .querySelector('#resource-list')
            ?.setAttribute('aria-labelledby', selected.navigationId ?? `${id}-tab`)
        if (notify) {
          options.onChange?.({ pane, ...(pane === 'resources' ? { tab: id as SettingsResourceTab } : {}) })
          if (!selected.nativePane)
            root.dispatchEvent(new CustomEvent('agnes:settings-page', { detail: id, bubbles: true }))
          const url = new URL(location.href)
          url.searchParams.set('settings', id)
          url.hash = route.anchor ?? ''
          history.replaceState(history.state, '', url)
        }
        if (route.anchor) requestAnimationFrame(() => revealSettingsAnchor(route.anchor ?? ''))
        if (notify && !tabFocused && window.matchMedia('(max-width: 767px)').matches)
          root.querySelector<HTMLButtonElement>('#settings-back')?.focus({ preventScroll: true })
        if (tabFocused)
          tabs?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus({ preventScroll: true })
      }
      navigateRef.current = navigate
      const onSearch = () => filter()
      search?.addEventListener('input', onSearch)
      listeners.push(() => search?.removeEventListener('input', onSearch))
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
          const entry = options.sections
            ?.entries()
            .find((entry) => entry.id === target.dataset.settingsSection)
          navigate(
            entry && search?.value && target.dataset.settingsGroup
              ? (options.sections
                  ?.entries()
                  .find(
                    (item) =>
                      settingsGroup(item.group) === settingsGroup(entry.group) &&
                      matchesSettings(search.value, options.translate?.(item.titleKey) ?? item.titleKey),
                  )?.id ?? entry.id)
              : target.dataset.settingsSection,
          )
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
        navigate(id)
        if (url.hash.length <= 1) return
        const next = new URL(location.href)
        next.hash = url.hash
        history.replaceState(history.state, '', next)
        let fragment: string
        try {
          fragment = decodeURIComponent(url.hash.slice(1))
        } catch {
          return
        }
        requestAnimationFrame(() => {
          const section = document.getElementById(fragment)
          section?.scrollIntoView({ block: 'start' })
          section?.focus()
        })
      }
      const onRoute = (event: Event) => {
        const id = String((event as CustomEvent).detail)
        // The embedded hub echoes its canonical page after mounting. Keep the
        // requested subsection through that echo, including before startup routing.
        const url = new URL(location.href)
        const requested = url.searchParams.get('settings') ?? ''
        const linked = settingsRoute(requested)
        const fragment = url.hash.slice(1)
        const anchoredId = fragment.replace(/^settings-subsection-/, '')
        const anchored = settingsRoute(anchoredId)
        navigate(
          linked.id === id && linked.anchor
            ? requested
            : requested === id && anchored.id === id && anchored.anchor === fragment
              ? anchoredId
              : id,
        )
      }
      const onKeys = (event: KeyboardEvent) => {
        const target = event.target as HTMLElement
        const modal = root.closest<HTMLDialogElement>('dialog')
        if (!root.contains(target) && !modal?.open) return
        if (target.closest?.('dialog') && target.closest('dialog') !== modal) return
        if (
          event.key === '/' &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !target.closest('input, textarea, select, [contenteditable=true]')
        ) {
          event.preventDefault()
          const shell = form()
          if (shell && window.matchMedia('(max-width: 767px)').matches) shell.dataset.settingsView = 'list'
          search?.focus()
          return
        }
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
        const query = search?.value ?? ''
        const wasAdvanced = advanced?.open ?? false
        // React reconciles the navigation while retaining search, native controls and outlets.
        flushSync(() => navigation.update({ entries, selected: root.dataset.settingsSection ?? 'model' }))
        const nextAdvanced = rail.querySelector<HTMLDetailsElement>('#settings-advanced')
        if (nextAdvanced) nextAdvanced.open = wasAdvanced
        advanced = nextAdvanced
        if (search) search.value = query
        const selected = root.dataset.settingsSection ?? 'model'
        const present = entries.some((entry) => entry.id === selected)
        navigate(present ? selected : (entries[0]?.id ?? 'model'), !present)
        filter()
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
      filter()
      let alive = true
      if (options.computerUseSupported)
        void options
          .computerUseSupported()
          .then((supported) => {
            if (!alive || computerUseSupported === supported) return
            computerUseSupported = supported
            syncEntries()
          })
          .catch(() => undefined)
      listeners.push(() => {
        alive = false
      })
    } else {
      bind('plugin-management', { pane: 'plugin' })
      bind('model-settings', { pane: 'model' })
      for (const button of root.querySelectorAll<HTMLButtonElement>('[data-runtime-page]')) {
        const listener = () => {
          root.dataset.runtimePage = button.dataset.runtimePage
          const shell = root.querySelector<HTMLElement>('#config-form')
          if (shell) shell.dataset.runtimePage = button.dataset.runtimePage
          open('plugin')
          options.onChange?.({ pane: 'plugin' })
          root.dispatchEvent(
            new CustomEvent('agnes:settings-page', { detail: button.dataset.runtimePage, bubbles: true }),
          )
        }
        button.addEventListener('click', listener)
        listeners.push(() => button.removeEventListener('click', listener))
      }
      bind('skills-tab', { pane: 'resources', tab: 'skills' })
      bind('mcp-tab', { pane: 'resources', tab: 'mcp' })
      bind('archived-settings', { pane: 'archived' })
      bind('computer-use-management', { pane: 'computer-use' })
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
          adminPanes={options.adminPanes}
          translate={options.translate}
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
  computerUse,
  adminPanes,
  translate,
}: {
  translate?: (key: string) => string
  pane: SettingsPane
  computerUse?: ReactNode
  adminPanes?: AdminPaneStore
}) {
  if (pane === 'computer-use' && computerUse)
    return (
      <div data-agnes-region-owner="builtin" data-agnes-region-unit="settings-computer-use">
        {computerUse}
      </div>
    )
  return (
    <div data-agnes-region-owner="builtin" data-agnes-region-unit={`settings-${pane}`}>
      {pane === 'model' ? (
        <SettingsModelPane
          {...(translate ? { t: translate } : {})}
          beforeAccounts={<SettingsDshHost name="settings.models.provider-card" />}
          afterAccounts={<SettingsDshHost name="settings.models.footer" />}
        />
      ) : (
        <SettingsStaticPane
          pane={pane}
          {...(adminPanes ? { adminPanes } : {})}
          {...(translate ? { translate } : {})}
        />
      )}
    </div>
  )
}
