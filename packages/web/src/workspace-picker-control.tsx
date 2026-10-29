import type { Translate } from '@agnes/web-conversation/presentation'
import { Button, Icon, IconButton, Popover, SettingsInput } from '@agnes/web-ui'
import type { WorkspacePickerProps } from '@agnes/web-units/shell'
import { type ReactElement, useEffect, useRef, useState } from 'react'
import { WorkspaceOptions } from './navigation.js'

const NO_MOTION = { motionName: '' }

/**
 * The composer's workspace chip: a popover to search and switch the draft's workspace, with
 * 「New workspace…」 handing over to the full dialog, and an × that leaves the workspace for a chat.
 */
export function WorkspacePickerControl({
  workspace,
  hidden,
  onWorkspace,
  onSelect,
  onRemove,
  t,
}: WorkspacePickerProps & { t: Translate }): ReactElement {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (workspace.disabled || hidden) setOpen(false)
  }, [workspace.disabled, hidden])
  const needle = query.trim().toLowerCase()
  const choices = workspace.choices ?? []
  const shown = needle
    ? choices.filter((row) => `${row.name}\n${row.path}`.toLowerCase().includes(needle))
    : choices
  const panel = (
    <section className="workspace-picker-panel" aria-label={t('composer.workspace.select')}>
      <div className="workspace-picker-search">
        <Icon name="search" />
        <SettingsInput
          type="search"
          autoFocus={true}
          autoComplete="off"
          aria-label={t('composer.workspace.search')}
          placeholder={t('composer.workspace.search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
            trigger.current?.focus()
          }}
        />
      </div>
      <div className="workspace-option-items">
        <WorkspaceOptions
          workspaces={shown}
          current={workspace.chats ? undefined : workspace.root}
          t={t}
          select={(row) => {
            setOpen(false)
            onSelect(row)
          }}
          {...(onRemove ? { remove: onRemove } : {})}
        />
      </div>
      <Button
        appearance="ghost"
        className="workspace-picker-create"
        onClick={() => {
          setOpen(false)
          onWorkspace()
        }}
      >
        <Icon name="plus" />
        {t('composer.workspace.create')}
      </Button>
    </section>
  )
  return (
    <span className="composer-workspace-picker" hidden={hidden}>
      <Popover
        open={open}
        trigger="click"
        placement="topLeft"
        arrow={false}
        destroyOnHidden={true}
        motion={NO_MOTION}
        rootClassName="workspace-picker-surface"
        onOpenChange={(next) => {
          if (next && workspace.disabled) return
          if (next) setQuery('')
          setOpen(next)
        }}
        content={panel}
      >
        <Button
          ref={trigger}
          id="composer-workspace"
          className="composer-workspace"
          appearance="ghost"
          size="small"
          hidden={hidden}
          htmlType="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          data-chats={workspace.chats ? 'true' : undefined}
          title={workspace.title}
          disabled={workspace.disabled}
        >
          <Icon name="folder" />
          <span data-workspace-label={true}>{workspace.label}</span>
          {workspace.path && <span data-workspace-path={true}>{workspace.path}</span>}
          <Icon name="chevron-down" className="model-chevron" />
        </Button>
      </Popover>
      {workspace.clearable && (
        <IconButton
          className="composer-workspace-clear"
          name="x"
          label={t('composer.workspace.clear')}
          disabled={workspace.disabled}
          onClick={() => onSelect('chats')}
        />
      )}
    </span>
  )
}
