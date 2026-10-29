import type { WorkspaceEntry } from '@agnes/protocol'
import type { Translate } from '@agnes/web-conversation/presentation'
import { Button, ConfirmDialog, Icon, Menu } from '@agnes/web-ui'
import { useLayoutEffect, useRef, useState } from 'react'
export function WorkspaceMenu({
  workspace,
  name,
  t,
  platform,
  disabled,
  newDisabled,
  runningCount,
  newSession,
  action,
  managed = false,
}: {
  workspace: WorkspaceEntry
  name: string
  t: Translate
  platform?: string | undefined
  disabled: boolean
  newDisabled: boolean
  runningCount: number
  newSession(): void
  action?: ((action: 'reveal' | 'remove', workspace: WorkspaceEntry) => Promise<void>) | undefined
  /** The daemon-managed chats workspace: only 「New session」, never reveal or remove. */
  managed?: boolean
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [confirm, setConfirm] = useState(false)
  const wasOpen = useRef(false)
  useLayoutEffect(() => {
    if (wasOpen.current && !confirm) trigger.current?.focus()
    wasOpen.current = confirm
  }, [confirm])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [serverRunning, setServerRunning] = useState(0)
  const running = Math.max(runningCount, serverRunning)
  const close = () => {
    if (pending) return
    setConfirm(false)
    trigger.current?.focus()
  }
  const perform = async (kind: 'reveal' | 'remove') => {
    if (!action || disabled || trigger.current?.disabled || pending || (kind === 'remove' && running)) return
    setPending(true)
    setError('')
    try {
      await action(kind, workspace)
      setConfirm(false)
      trigger.current?.focus()
    } catch (failure) {
      const data = (failure as { data?: { code?: string; runningSessionCount?: number } } | undefined)?.data
      if (data?.code === 'WORKSPACE_RUNNING') setServerRunning(data.runningSessionCount || 1)
      else setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setPending(false)
    }
  }
  const button = (
    <Button
      ref={trigger}
      appearance="ghost"
      className="workspace-menu-trigger"
      disabled={disabled || pending}
      aria-label={t('workspace.menu.label', { name })}
      aria-haspopup="menu"
      aria-expanded={false}
    >
      <Icon name="ellipsis" />
    </Button>
  )
  return (
    <>
      <div className="workspace-row-actions">
        <Button
          appearance="ghost"
          className="workspace-new-session"
          data-workspace-new-session={workspace.path}
          aria-label={t('nav.newSessionInWorkspace', { name })}
          title={t('nav.newSessionInWorkspace', { name })}
          disabled={newDisabled}
          onClick={newSession}
        >
          <Icon name="compose" />
        </Button>
        {managed ? null : disabled || pending ? (
          button
        ) : (
          <Menu
            tone="neutral"
            label={t('workspace.menu.label', { name })}
            trigger={button}
            items={[
              {
                id: 'new',
                label: t('workspace.menu.new'),
                icon: <Icon name="compose" />,
                disabled: newDisabled,
                onSelect: () => {
                  if (!disabled && !newDisabled && !trigger.current?.disabled) newSession()
                },
              },
              {
                id: 'reveal',
                label: t(
                  platform === 'darwin'
                    ? 'session.menu.openFinder'
                    : platform === 'win32'
                      ? 'session.menu.openExplorer'
                      : 'session.menu.openFolder',
                ),
                icon: <Icon name="folder-open" />,
                disabled: !action || !workspace.available || pending,
                onSelect: () => void perform('reveal'),
              },
              {
                id: 'remove',
                label: t('workspace.menu.remove'),
                icon: <Icon name="x" />,
                danger: true,
                dividerBefore: true,
                disabled: !action || !workspace.workspaceId || pending,
                onSelect: () => {
                  if (disabled || trigger.current?.disabled) return
                  setError('')
                  setServerRunning(0)
                  setConfirm(true)
                },
              },
            ]}
          />
        )}
      </div>
      {error && !confirm && (
        <span role="alert" className="workspace-action-error">
          {error}
        </span>
      )}
      {confirm && (
        <ConfirmDialog
          open
          title={t('workspace.remove.title', { name })}
          onCancel={close}
          onConfirm={() => void perform('remove')}
          confirmLabel={t('workspace.remove.confirm')}
          cancelLabel={t('workspace.remove.cancel')}
          destructive
          busy={pending}
          confirmDisabled={disabled || running > 0}
        >
          <p>{t('workspace.remove.description', { count: workspace.sessionCount })}</p>
          <p className="workspace-remove-path">
            <code>{workspace.path}</code>
          </p>
          {running > 0 && <p role="alert">{t('workspace.remove.running', { count: running })}</p>}
          {error && <p role="alert">{error}</p>}
        </ConfirmDialog>
      )}
    </>
  )
}
