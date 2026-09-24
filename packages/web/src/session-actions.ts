import type { PageSessionMeta } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'

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
}) {
  const dialog = document.createElement('dialog')
  dialog.className = 'session-rename-dialog'
  dialog.setAttribute('aria-labelledby', 'session-rename-heading')
  dialog.dataset.agnesRegion = 'dialog'
  dialog.innerHTML = `<form>
    <div class="dialog-heading"><h2 id="session-rename-heading">重命名会话</h2></div>
    <label class="form-field" for="session-rename-input">会话名称
      <input id="session-rename-input" required autocomplete="off" aria-describedby="session-rename-error" />
    </label>
    <p id="session-rename-error" class="session-rename-error" role="alert"></p>
    <div class="dialog-actions"><button class="secondary-button" type="button">取消</button><button class="primary-button" type="submit">重命名</button></div></form>`
  document.body.append(dialog)
  const form = dialog.querySelector('form') as HTMLFormElement
  const input = dialog.querySelector('input') as HTMLInputElement
  const error = dialog.querySelector('p') as HTMLParagraphElement
  const cancel = dialog.querySelector('button') as HTMLButtonElement
  const submit = dialog.querySelector('[type=submit]') as HTMLButtonElement
  let target: string | undefined
  let pending = false
  let saved = false
  let returnFocus: HTMLElement | undefined
  const text = (failure: unknown) => (failure instanceof Error ? failure.message : '操作失败，请重试。')
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
      error.textContent = '请输入 1–80 个字符的单行名称。'
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
        error.textContent = saved ? `名称已保存，但列表刷新失败：${text(failure)}` : text(failure)
      } finally {
        pending = submit.disabled = cancel.disabled = false
        input.disabled = saved
        submit.textContent = saved ? '重试刷新' : '重命名'
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
      title.textContent = row.title ?? '未命名会话'
      const location = document.createElement('p')
      location.textContent = row.cwd ?? '未分类'
      copy.append(title, location)
      const restore = document.createElement('button')
      restore.type = 'button'
      restore.textContent = restoring.has(row.sessionId) ? '正在恢复…' : '取消归档'
      restore.setAttribute('aria-label', `取消归档 ${title.textContent}`)
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
            await loadArchived('已取消归档，但列表刷新失败：')
            if (archivedView()?.rows === rows) search.focus()
          } catch (failure) {
            const current = archivedView()
            if (current)
              current.message.textContent = restored
                ? `已取消归档，但列表刷新失败：${text(failure)}`
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
    empty.textContent = visible.length ? '' : archived.length ? '没有匹配的已归档会话。' : '暂无已归档会话。'
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
        if (page.next === cursor && page.next !== undefined) throw new Error('会话列表分页未推进，请重试。')
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
        if (archivedView()?.rows === view.rows) view.message.textContent = `列表刷新失败：${text(failure)}`
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
        submit.textContent = '重命名'
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
          archivedSuccessfully ? new Error(`已归档，但列表刷新失败，请刷新页面：${text(failure)}`) : failure,
        )
      } finally {
        busy.delete(id)
        trigger.removeAttribute('aria-busy')
      }
    },
  }
}
