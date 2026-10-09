import { createSettingsButton } from '@agnes/web-ui'
import type { PageSessionMeta } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import type { Translate } from '@agnes/web-conversation/presentation'
import { materializeSettingsControls } from '@agnes/web-ui'

export type SessionAction = 'rename' | 'fork' | 'archive'

export function forkTitle(title: string): string {
  const match = /^(.*) \((\d+)\)$/.exec(title)
  const count = match ? Number(match[2]) + 1 : 1
  const suffix = ` (${Number.isSafeInteger(count) ? count : 1})`
  return (
    Array.from(match?.[1] ?? title)
      .slice(0, 80 - suffix.length)
      .join('') + suffix
  )
}

/** Uses the existing SDK and native dialog focus behavior, without another UI state store. */
export function createSessionActions(options: {
  client: Client
  changed(): Promise<unknown>
  fork(id: string, title: string): Promise<void>
  error(error: unknown): void
  translate: Translate
}) {
  const t = options.translate
  const dialog = document.createElement('dialog')
  dialog.className = 'session-rename-dialog'
  dialog.setAttribute('aria-labelledby', 'session-rename-heading')
  dialog.dataset.agnesRegion = 'dialog'
  dialog.innerHTML = `<form>
    <div class="dialog-heading"><h2 id="session-rename-heading"></h2></div>
    <label class="form-field" for="session-rename-input">
      <span id="session-rename-label"></span>
      <template data-agnes-control="input" id="session-rename-input" required autocomplete="off" aria-describedby="session-rename-error" ></template>
    </label>
    <p id="session-rename-error" class="session-rename-error agnes-settings-state" data-tone="error" role="alert"></p>
    <div class="dialog-actions"><button class="secondary-button" type="button"></button><button class="primary-button" type="submit"></button></div></form>`
  materializeSettingsControls(dialog)
  document.body.append(dialog)
  const heading = dialog.querySelector('h2') as HTMLHeadingElement
  const nameLabel = dialog.querySelector('#session-rename-label') as HTMLElement
  const form = dialog.querySelector('form') as HTMLFormElement
  const input = dialog.querySelector('input') as HTMLInputElement
  const error = dialog.querySelector('p') as HTMLParagraphElement
  const cancel = dialog.querySelector('button') as HTMLButtonElement
  const submit = dialog.querySelector('[type=submit]') as HTMLButtonElement
  let target: string | undefined
  let pending = false
  let saved = false
  let returnFocus: HTMLElement | undefined
  // 弹窗只创建一次，所以在每次打开时重新取词，否则切换语言后它仍显示启动时的文案。
  const applyStaticText = (): void => {
    heading.textContent = t('session.rename.heading')
    nameLabel.textContent = t('session.rename.nameLabel')
    cancel.textContent = t('session.rename.cancel')
    submit.textContent = saved ? t('session.rename.retryRefresh') : t('session.rename.submit')
  }
  const text = (failure: unknown) =>
    failure instanceof Error ? failure.message : t('session.rename.defaultError')
  const close = () => {
    if (!pending) dialog.close()
  }
  cancel.addEventListener('click', close)
  dialog.addEventListener('cancel', (event) => {
    if (pending) event.preventDefault()
  })
  dialog.addEventListener('close', () => {
    if (returnFocus?.isConnected) returnFocus.focus()
    else
      document.querySelector<HTMLElement>(`[data-session-action-id="${CSS.escape(target ?? '')}"]`)?.focus()
  })
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!target || pending) return
    const title = input.value.trim()
    if (
      !title ||
      Array.from(title).length > 80 ||
      /[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/u.test(title)
    ) {
      error.textContent = t('session.rename.invalidName')
      input.setAttribute('aria-invalid', 'true')
      input.focus()
      return
    }
    const id = target
    pending = submit.disabled = cancel.disabled = true
    input.disabled = true
    dialog.setAttribute('aria-busy', 'true')
    error.textContent = ''
    input.removeAttribute('aria-invalid')
    void (async () => {
      try {
        if (!saved) {
          await options.client.session.rename(id, title)
          saved = true
        }
        await options.changed()
        dialog.close()
      } catch (failure) {
        error.textContent = saved
          ? t('session.rename.savedRefreshFailed', { detail: text(failure) })
          : text(failure)
      } finally {
        pending = submit.disabled = cancel.disabled = false
        input.disabled = saved
        applyStaticText()
        dialog.removeAttribute('aria-busy')
        if (dialog.open) (saved ? submit : input).focus()
      }
    })()
  })

  let disposed = false
  const archivedView = () => {
    if (disposed) return undefined
    const pane = document.getElementById('archived-settings-pane')
    const search = pane?.querySelector<HTMLInputElement>('#archived-search')
    const rows = pane?.querySelector<HTMLElement>('#archived-list')
    const message = pane?.querySelector<HTMLElement>('#archived-message')
    const empty = pane?.querySelector<HTMLElement>('#archived-empty')
    if (pane && search && rows && message && empty) return { pane, search, rows, message, empty }
    return undefined
  }
  let archived: PageSessionMeta['items'] = []
  let epoch = 0
  const restoring = new Set<string>()
  const renderArchived = () => {
    const view = archivedView()
    if (!view) return
    const { search, rows, message, empty } = view
    const query = search.value.trim().toLocaleLowerCase()
    const visible = archived.filter((row) =>
      `${row.title ?? row.sessionId} ${row.cwd ?? ''}`.toLocaleLowerCase().includes(query),
    )
    rows.replaceChildren()
    for (const row of visible) {
      const item = document.createElement('li')
      const copy = document.createElement('div')
      const title = document.createElement('strong')
      title.textContent = row.title ?? t('session.archived.unnamed')
      const location = document.createElement('p')
      location.textContent = row.cwd ?? t('session.uncategorized')
      copy.append(title, location)
      const restore = createSettingsButton(document)
      restore.type = 'button'
      const restoreLabel = t('session.archived.restore')
      restore.textContent = restoring.has(row.sessionId) ? t('session.archived.restoring') : restoreLabel
      restore.setAttribute(
        'aria-label',
        t('session.archived.restoreAria', { title: title.textContent ?? '' }),
      )
      restore.disabled = restoring.has(row.sessionId)
      restore.addEventListener('click', () => {
        if (archivedView()?.rows !== rows || restoring.has(row.sessionId)) return
        restoring.add(row.sessionId)
        message.textContent = ''
        renderArchived()
        void (async () => {
          let restored = false
          try {
            await options.client.session.archive(row.sessionId, false)
            restored = true
            ++epoch
            archivedView()?.pane.removeAttribute('aria-busy')
            archived = archived.filter((item) => item.sessionId !== row.sessionId)
            renderArchived()
            await options.changed()
            await loadArchived(t('session.archived.refreshFailedPrefix'))
            if (archivedView()?.rows === rows) search.focus()
          } catch (failure) {
            const current = archivedView()
            if (current)
              current.message.textContent = restored
                ? t('session.archived.refreshFailedPrefix') + text(failure)
                : text(failure)
          } finally {
            restoring.delete(row.sessionId)
            renderArchived()
          }
        })()
      })
      item.append(copy, restore)
      rows.append(item)
    }
    empty.textContent = visible.length
      ? ''
      : archived.length
        ? t('session.archived.empty.noMatch')
        : t('session.archived.empty.fallback')
  }
  const loadArchived = async (failurePrefix = '') => {
    const view = archivedView()
    if (!view) return
    const { pane, message } = view
    const version = ++epoch
    const current = () => version === epoch && archivedView()?.rows === view.rows
    pane.setAttribute('aria-busy', 'true')
    message.textContent = ''
    try {
      const all: PageSessionMeta['items'] = []
      let cursor: string | undefined
      do {
        const page = await options.client.session.list({ limit: 500, ...(cursor ? { cursor } : {}) })
        if (!current()) return
        all.push(...page.items.filter((row) => row.archived))
        if (page.next === cursor && page.next !== undefined)
          throw new Error(t('session.archived.paginationStalled'))
        cursor = page.next
      } while (cursor !== undefined)
      archived = all
      renderArchived()
    } catch (failure) {
      if (current()) message.textContent = failurePrefix + text(failure)
    } finally {
      if (current()) pane.removeAttribute('aria-busy')
    }
  }
  const onSearch = (event: Event) => {
    if (event.target === archivedView()?.search) renderArchived()
  }
  const onRefresh = (event: Event) => {
    const view = archivedView()
    if (!view || !(event.target instanceof Element)) return
    const button = event.target.closest('button')
    if (!button || button.disabled || button !== view.pane.querySelector('#archived-refresh')) return
    void (async () => {
      try {
        await options.changed()
        if (archivedView()?.rows === view.rows) await loadArchived()
      } catch (failure) {
        if (archivedView()?.rows === view.rows)
          view.message.textContent = t('session.refreshFailed', { detail: text(failure) })
      }
    })()
  }
  document.addEventListener('input', onSearch, true)
  document.addEventListener('click', onRefresh)
  // A real plugin replacement still remounts root panes. Retire old reads and
  // repopulate the new built-in pane; DOM writes within the same pane do nothing.
  let observedRows = archivedView()?.rows
  const observer = new MutationObserver(() => {
    const rows = archivedView()?.rows
    if (rows === observedRows) return
    observedRows = rows
    ++epoch
    if (rows) void loadArchived()
  })
  observer.observe(document.getElementById('config') ?? document.body, { childList: true, subtree: true })
  const dispose = () => {
    disposed = true
    ++epoch
    observer.disconnect()
    document.removeEventListener('input', onSearch, true)
    document.removeEventListener('click', onRefresh)
    window.removeEventListener('pagehide', dispose)
    dialog.remove()
  }
  window.addEventListener('pagehide', dispose, { once: true })
  const busy = new Set<string>()
  return {
    dispose,
    loadArchived,
    async act(action: SessionAction, id: string, title: string, trigger: HTMLElement) {
      if (disposed) return
      if (action === 'rename') {
        if (dialog.open) return
        target = id
        returnFocus = trigger
        saved = false
        input.disabled = false
        applyStaticText()
        input.value = title
        error.textContent = ''
        input.removeAttribute('aria-invalid')
        dialog.showModal()
        input.focus()
        input.select()
        return
      }
      if (busy.has(id)) return
      busy.add(id)
      trigger.setAttribute('aria-busy', 'true')
      let archivedSuccessfully = false
      try {
        if (action === 'fork') await options.fork(id, title)
        else {
          await options.client.session.archive(id, true)
          archivedSuccessfully = true
          await options.changed()
          document.querySelector<HTMLElement>('#sessions button')?.focus()
        }
      } catch (failure) {
        options.error(
          archivedSuccessfully
            ? new Error(t('session.archiveRefreshFailedNotice', { detail: text(failure) }))
            : failure,
        )
      } finally {
        busy.delete(id)
        trigger.removeAttribute('aria-busy')
      }
    },
  }
}
