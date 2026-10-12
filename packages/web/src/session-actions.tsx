import type { PageSessionMeta } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import type { Translate } from '@agnes/web-conversation/presentation'
import { Button, createRegionHost, Dialog, renderRegion, SettingsInput, unmountRegion } from '@agnes/web-ui'

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

/** The existing action controller owns SDK writes, retries and pending state. */
export function createSessionActions(options: {
  client: Client
  changed(): Promise<unknown>
  fork(id: string, title: string): Promise<void>
  error(error: unknown): void
  translate: Translate
}) {
  const t = options.translate
  const host = createRegionHost(document.body, 'div')
  let target: string | undefined
  let pending = false
  let saved = false
  let opened = false
  let initialTitle = ''
  let renameVersion = 0
  let message = ''
  let invalid = false
  let input: HTMLInputElement | null = null
  let submit: HTMLButtonElement | null = null
  let returnFocus: HTMLElement | undefined
  const text = (failure: unknown) =>
    failure instanceof Error ? failure.message : t('session.rename.defaultError')
  const restoreFocus = () => {
    if (returnFocus?.isConnected) returnFocus.focus()
    else
      document.querySelector<HTMLElement>(`[data-session-action-id="${CSS.escape(target ?? '')}"]`)?.focus()
  }
  const close = () => {
    if (pending) return
    opened = false
    renderRename()
    restoreFocus()
  }
  const save = () => {
    if (!target || pending) return
    const title = input?.value.trim() ?? ''
    if (
      !title ||
      Array.from(title).length > 80 ||
      /[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/u.test(title)
    ) {
      message = t('session.rename.invalidName')
      invalid = true
      renderRename()
      input?.focus()
      return
    }
    const id = target
    pending = true
    message = ''
    invalid = false
    renderRename()
    void (async () => {
      try {
        if (!saved) {
          await options.client.session.rename(id, title)
          saved = true
        }
        await options.changed()
        opened = false
      } catch (failure) {
        message = saved ? t('session.rename.savedRefreshFailed', { detail: text(failure) }) : text(failure)
      } finally {
        pending = false
        if (!disposed) {
          renderRename()
          if (opened) (saved ? submit : input)?.focus()
          else restoreFocus()
        }
      }
    })()
  }
  const renderRename = () =>
    renderRegion(
      host,
      <dialog
        open={opened}
        hidden={!opened}
        role="presentation"
        className="react-dialog-host"
        data-agnes-region="dialog"
      >
        <Dialog
          open={opened}
          width={480}
          focusable={{ focusTriggerAfterClose: false }}
          footer={null}
          closable={{ disabled: pending }}
          onCancel={close}
          className="session-rename-dialog"
          title={<h2 id="session-rename-heading">{t('session.rename.heading')}</h2>}
          afterOpenChange={(open) => {
            if (open && opened) {
              input?.focus()
              input?.select()
            }
          }}
        >
          <form
            aria-busy={pending || undefined}
            onSubmit={(event) => {
              event.preventDefault()
              save()
            }}
          >
            <label className="form-field" htmlFor="session-rename-input">
              <span id="session-rename-label">{t('session.rename.nameLabel')}</span>
              <SettingsInput
                key={renameVersion}
                ref={(node) => {
                  input = node
                }}
                id="session-rename-input"
                defaultValue={initialTitle}
                required
                autoComplete="off"
                aria-describedby="session-rename-error"
                aria-invalid={invalid || undefined}
                disabled={pending || saved}
              />
            </label>
            <p id="session-rename-error" className="session-rename-error" role="alert">
              {message}
            </p>
            <div className="dialog-actions">
              <Button disabled={pending} onClick={close}>
                {t('session.rename.cancel')}
              </Button>
              <Button
                ref={(node) => {
                  submit = node
                }}
                appearance="primary"
                htmlType="submit"
                disabled={pending}
              >
                {t(saved ? 'session.rename.retryRefresh' : 'session.rename.submit')}
              </Button>
            </div>
          </form>
        </Dialog>
      </dialog>,
    )

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
    renderRegion(
      rows,
      visible.map((row) => {
        const title = row.title ?? t('session.archived.unnamed')
        const restore = () => {
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
        }
        return (
          <li key={row.sessionId}>
            <div>
              <strong>{title}</strong>
              <p>{row.cwd ?? t('session.uncategorized')}</p>
            </div>
            <Button
              aria-label={t('session.archived.restoreAria', { title })}
              disabled={restoring.has(row.sessionId)}
              onClick={restore}
            >
              {t(restoring.has(row.sessionId) ? 'session.archived.restoring' : 'session.archived.restore')}
            </Button>
          </li>
        )
      }),
    )
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
    if (observedRows) unmountRegion(observedRows)
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
    if (observedRows) unmountRegion(observedRows)
    unmountRegion(host)
    host.remove()
  }
  window.addEventListener('pagehide', dispose, { once: true })
  const busy = new Set<string>()
  return {
    dispose,
    loadArchived,
    async act(action: SessionAction, id: string, title: string, trigger: HTMLElement) {
      if (disposed) return
      if (action === 'rename') {
        if (opened) return
        target = id
        returnFocus = trigger
        saved = false
        initialTitle = title
        renameVersion++
        message = ''
        invalid = false
        opened = true
        renderRename()
        input?.focus()
        input?.select()
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
