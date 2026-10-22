import type { Client } from '@agnes/sdk/browser'
import type { Translate } from '@agnes/web-conversation/presentation'
import {
  Button,
  createRegionHost,
  Dialog,
  renderRegion,
  reportSuccess,
  SettingsInput,
  unmountRegion,
} from '@agnes/web-ui'

import { createRuntimeDialog } from './session-runtime-dialog.js'

export type SessionAction =
  | 'pin'
  | 'unpin'
  | 'rename'
  | 'fork'
  | 'archive'
  | 'unarchive'
  | 'runtime'
  | 'revealWorkspace'

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

const validRenameTitle = (title: string): boolean =>
  !!title && Array.from(title).length <= 80 && !/[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/u.test(title)

/** The existing action controller owns SDK writes, retries and pending state. */
export function createSessionActions(options: {
  client: Client
  changed(): Promise<unknown>
  renamed?(id: string, title: string): void
  fork(id: string, title: string): Promise<void>
  error(error: unknown): void
  /** A session left the list for the archive; the host says where it went. */
  archived?(id: string): void
  translate: Translate
  /** Names a loop for the runtime info dialog; ids are shown when it knows none. */
  loopLabel?: ((id: string) => string | undefined) | undefined
  /** The permission level a session runs under, when the session list reports it. */
  permissionOf?: ((id: string) => string | undefined) | undefined
}) {
  const t = options.translate
  let runtimeDialog: ReturnType<typeof createRuntimeDialog> | undefined
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
  const writeTitle = async (id: string, title: string) => {
    if (!validRenameTitle(title)) throw new Error(t('session.rename.invalidName'))
    await options.client.session.rename(id, title)
    options.renamed?.(id, title)
  }
  const save = () => {
    if (!target || pending) return
    const title = input?.value.trim() ?? ''
    if (!validRenameTitle(title)) {
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
          await writeTitle(id, title)
          reportSuccess('session-title', t('session.rename.saved'))
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
                loading={pending}
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
  const dispose = () => {
    disposed = true
    runtimeDialog?.dispose()
    window.removeEventListener('pagehide', dispose)
    unmountRegion(host)
    host.remove()
  }
  window.addEventListener('pagehide', dispose, { once: true })
  const busy = new Set<string>()
  return {
    dispose,
    invalidateRuntime(id: string) {
      void runtimeDialog?.invalidate(id)
    },
    renameInline(id: string, initialTitle: string) {
      let persisted = initialTitle
      return async (title: string) => {
        if (disposed) return
        title = title.trim()
        if (!validRenameTitle(title)) throw new Error(t('session.rename.invalidName'))
        if (title !== persisted) {
          await writeTitle(id, title)
          reportSuccess('session-title', t('session.rename.saved'))
          persisted = title
        }
        try {
          await options.changed()
        } catch (failure) {
          throw new Error(t('session.rename.savedRefreshFailed', { detail: text(failure) }))
        }
      }
    },
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
      if (action === 'runtime') {
        runtimeDialog ??= createRuntimeDialog({
          client: options.client,
          translate: t,
          error: options.error,
          loopLabel: options.loopLabel,
          permissionOf: options.permissionOf,
        })
        return runtimeDialog.open(id, trigger)
      }
      if (busy.has(id)) return
      busy.add(id)
      trigger.setAttribute('aria-busy', 'true')
      let archivedSuccessfully = false
      try {
        if (action === 'revealWorkspace')
          await options.client.call('_agnes/v1/session.revealWorkspace', { sessionId: id })
        else if (action === 'fork') await options.fork(id, title)
        else if (action === 'pin' || action === 'unpin') {
          // The daemon moves the row between groups; the refresh reloads both of them.
          await options.client.session.pin(id, action === 'pin')
          await options.changed()
        } else {
          await options.client.session.archive(id, true)
          archivedSuccessfully = true
          reportSuccess('session-archive', t('session.archivedNotice'))
          await options.changed()
          options.archived?.(id)
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
