import type { SchedulesListParams } from '@agnes/protocol'
import { Field, SettingsInput, SettingsSelect } from '@agnes/web-ui'
import type { ScheduleRow, SessionInfo, Workspace } from './schedule-model.js'
import type { Text } from './schedule-text.js'

export type TaskStatus = NonNullable<SchedulesListParams['status']> | 'all'
export function matchesSchedule(
  row: ScheduleRow,
  search: string,
  status: TaskStatus,
  workspace: string,
  sessions: ReadonlyMap<string, SessionInfo>,
) {
  if (search.trim() && !(row.title + '\n' + row.prompt).toLowerCase().includes(search.trim().toLowerCase()))
    return false
  const cwd = row.target.kind === 'new-session' ? row.target.cwd : sessions.get(row.target.sessionKey)?.cwd
  // Unknown session labels do not erase an authoritative server-side workspace match.
  if (workspace && cwd !== undefined && cwd !== workspace) return false
  if (status === 'failed') return row.runs.at(-1)?.outcome === 'failed'
  if (status === 'needs_attention')
    return row.runs.some((run) => ['waiting_approval', 'needs_attention'].includes(run.outcome))
  return status === 'all' || row.status === status
}

export function ScheduleFilters({
  search,
  status,
  workspace,
  workspaces,
  onSearch,
  onStatus,
  onWorkspace,
  ux,
}: {
  search: string
  status: TaskStatus
  workspace: string
  workspaces: readonly Workspace[]
  onSearch(value: string): void
  onStatus(value: TaskStatus): void
  onWorkspace(value: string): void
  ux: Text
}) {
  return (
    <div className="agnes-settings-filters">
      <Field label={ux('taskSearch')}>
        <SettingsInput
          data-testid="schedules-search"
          aria-label={ux('taskSearch')}
          type="search"
          maxLength={256}
          value={search}
          onChange={(event) => onSearch(event.target.value)}
        />
      </Field>
      <Field label={ux('taskStatus')}>
        <SettingsSelect
          data-testid="schedules-status-filter"
          aria-label={ux('taskStatus')}
          value={status}
          onChange={(event) => onStatus(event.target.value as TaskStatus)}
        >
          {['all', 'active', 'paused', 'ended', 'archived', 'failed', 'needs_attention'].map((value) => (
            <option key={value} value={value}>
              {ux(`filterStatus.${value}`)}
            </option>
          ))}
        </SettingsSelect>
      </Field>
      <Field label={ux('workspace')}>
        <SettingsSelect
          data-testid="schedules-workspace-filter"
          aria-label={ux('workspace')}
          value={workspace}
          onChange={(event) => onWorkspace(event.target.value)}
        >
          <option value="">{ux('allWorkspaces')}</option>
          {workspaces.map((item) => (
            <option key={item.path} value={item.path}>
              {item.name}
            </option>
          ))}
        </SettingsSelect>
      </Field>
    </div>
  )
}
