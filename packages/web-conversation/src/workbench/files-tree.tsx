import type { SessionWorkspaceChange, SessionWorkspaceListResult } from '@agnes/protocol'
import type { UiExtensionContext } from '@agnes/web-client'
import { Button, Icon, IconButton } from '@agnes/web-ui'
import { fileType } from './file-types.js'

export type SessionChange = Pick<SessionWorkspaceChange, 'kind' | 'added' | 'removed'>

/** A row's A / M mark: what this session did to the file, from the review tab's own change list. */
export function ChangeBadge({ change, t }: { change: SessionChange; t: UiExtensionContext['t'] }) {
  const label = t(`workbench.files.change.${change.kind}`)
  return (
    <span
      className="workbench-file-change"
      data-kind={change.kind}
      data-testid="file-change-badge"
      title={label}
    >
      <span aria-hidden="true">{change.kind === 'added' ? 'A' : 'M'}</span>
      <span className="agh-visually-hidden">{label}</span>
    </span>
  )
}

/**
 * Only what is already loaded is filtered: a name matches, or a directory holds a loaded match. A
 * directory that matches keeps all of its loaded children, so its contents stay browsable.
 */
export function FileTree({
  directories,
  expanded,
  selected,
  query,
  changes,
  t,
  toggle,
  select,
  mentionFolder,
}: {
  directories: Record<string, SessionWorkspaceListResult>
  expanded: readonly string[]
  selected: string
  query: string
  changes: ReadonlyMap<string, SessionChange>
  t: UiExtensionContext['t']
  toggle(path: string): void
  select(path: string): void
  /** Name a folder in the prompt; files are named from their preview. */
  mentionFolder?(path: string): void
}) {
  const needle = query.trim().toLowerCase()
  const matches = (path: string, name: string, kind: string): boolean =>
    name.toLowerCase().includes(needle) ||
    (kind === 'directory' &&
      !!directories[path]?.entries.some((entry) => matches(`${path}/${entry.name}`, entry.name, entry.kind)))
  const tree = (path: string, all: boolean) => (
    <ul className="workbench-file-tree">
      {directories[path]?.entries.map((entry) => {
        const child = path ? `${path}/${entry.name}` : entry.name
        if (needle && !all && !matches(child, entry.name, entry.kind)) return null
        const directory = entry.kind === 'directory'
        const open = expanded.includes(child)
        const type = directory ? undefined : fileType(entry.name)
        const change = directory ? undefined : changes.get(child)
        return (
          <li key={child}>
            <Button
              type="text"
              size="small"
              disabled={entry.kind === 'other'}
              className="workbench-file-entry"
              data-testid="workspace-file"
              data-path={child}
              aria-expanded={directory ? open : undefined}
              aria-pressed={directory ? undefined : selected === child}
              onClick={() => (directory ? toggle(child) : select(child))}
            >
              <span className="workbench-file-chevron" data-open={open || undefined} aria-hidden="true">
                {directory && <Icon name="chevron-right" />}
              </span>
              {type ? (
                <span className="workbench-file-type" data-tone={type.tone} aria-hidden="true">
                  {type.label}
                </span>
              ) : (
                <Icon
                  name={directory ? (open ? 'folder-open' : 'folder') : 'file'}
                  className="workbench-file-icon"
                />
              )}
              <span className="workbench-file-name" translate="no">
                {entry.name}
              </span>
              {change && <ChangeBadge change={change} t={t} />}
              {entry.git && (
                <span
                  className="workbench-git-mark"
                  data-git={entry.git}
                  title={t(`workbench.git.${entry.git}`)}
                >
                  <span className="agh-visually-hidden">{t(`workbench.git.${entry.git}`)}</span>
                </span>
              )}
            </Button>
            {directory && mentionFolder ? (
              <IconButton
                name="at-sign"
                className="workbench-folder-mention"
                data-testid="workspace-folder-mention"
                label={t('workbench.files.mentionFolder', { name: entry.name })}
                onClick={() => mentionFolder(child)}
              />
            ) : null}
            {directory && open && tree(child, all || (!!needle && entry.name.toLowerCase().includes(needle)))}
          </li>
        )
      })}
    </ul>
  )
  return tree('', false)
}

/** Count of loaded rows a filter keeps, for the footer and the no-match state. */
export function countVisible(
  directories: Record<string, SessionWorkspaceListResult>,
  expanded: readonly string[],
  query: string,
): number {
  const needle = query.trim().toLowerCase()
  const count = (path: string, all: boolean): number =>
    (directories[path]?.entries ?? []).reduce((total, entry) => {
      const child = path ? `${path}/${entry.name}` : entry.name
      const hit = entry.name.toLowerCase().includes(needle)
      const inner = entry.kind === 'directory' && expanded.includes(child) ? count(child, all || hit) : 0
      return total + (!needle || all || hit || inner > 0 ? 1 + inner : 0)
    }, 0)
  return count('', false)
}
