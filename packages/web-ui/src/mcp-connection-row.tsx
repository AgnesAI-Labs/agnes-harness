import type { McpServerDescriptor } from '@agnes/protocol'
import { resourceFailureLabel } from './resource-failure.js'
import { mcpConnectionCatalog } from './locales/mcp-connection.js'
import { Button } from './ui/button.js'
import { IconButton } from './ui/icon-button.js'
import { ListRow } from './ui/list-row.js'
import { Menu } from './ui/menu.js'
import { StateSwitch } from './ui/state-lights.js'
import { Tag } from './ui/tag.js'
import { useUiText } from './ui-locale.js'

export type McpRowActions = { edit(): void; test(): void; remove(): void }
export function McpConnectionRow({
  item,
  itemName,
  selected,
  disabled,
  onOpen,
  onToggle,
  actions,
}: {
  item: McpServerDescriptor
  itemName: string
  selected: boolean
  disabled: boolean
  onOpen(): void
  onToggle(next: boolean): void
  actions?: McpRowActions | undefined
}) {
  const { t } = useUiText('@agnes/web-ui/mcp-connections', mcpConnectionCatalog)
  const connection = item.definition.transport
  let address = ''
  if (connection.kind === 'stdio') address = [connection.executable, ...connection.args].join(' ')
  else {
    try {
      address = new URL(connection.url).host
    } catch {
      /* Keep invalid addresses out of the summary. */
    }
  }
  return (
    <ListRow
      className="resource-row"
      data-resource-id={item.resourceId}
      data-selected={String(selected)}
      title={
        <Button
          appearance="ghost"
          aria-pressed={selected}
          aria-label={t('open', { name: itemName })}
          onClick={onOpen}
        >
          {itemName}
        </Button>
      }
      meta={`${t(connection.kind === 'stdio' ? 'local' : 'remote')} · ${address}`}
      status={
        item.lastSafeError ? (
          <Tag tone="bad">{resourceFailureLabel(item.lastSafeError.code, t)}</Tag>
        ) : undefined
      }
      actions={
        <>
          {item.lastSafeError && actions && (
            <Button disabled={disabled} onClick={actions.test}>
              {t('retry')}
            </Button>
          )}
          <StateSwitch
            label={t(item.desired === 'enabled' ? 'disable' : 'enable', { name: itemName })}
            checked={item.desired === 'enabled'}
            disabled={disabled}
            onToggle={onToggle}
          />
          {actions && (
            <Menu
              label={t('actions')}
              trigger={<IconButton name="ellipsis" label={t('actions')} />}
              items={[
                { id: 'edit', label: t('edit'), disabled, onSelect: actions.edit },
                { id: 'test', label: t('test'), disabled, onSelect: actions.test },
                { id: 'remove', label: t('remove'), danger: true, disabled, onSelect: actions.remove },
              ]}
            />
          )}
        </>
      }
    />
  )
}
