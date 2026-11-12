import { Button, Disclosure, Icon, SettingsInput } from '@agnes/web-ui'
import { useState } from 'react'
import { CloudConnectionIndicator } from './cloud-connection-status.js'
import {
  type BackendCommand,
  type BackendId,
  type BackendSnapshot,
  backendSessionKey,
} from './frame-contract.js'
import type { WorkbenchText } from './workbench-locale.js'
import { cloudConnectionState } from './workbench-state.js'

export function WorkbenchSidebar(props: {
  active: BackendId
  cloud?: string
  states: Partial<Record<BackendId, BackendSnapshot>>
  t: WorkbenchText
  select(id: BackendId, sessionId?: string): void
  command(id: BackendId, command: BackendCommand): void
  configure(): void
}) {
  const { t } = props
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState({ local: true, cloud: true })
  const create = (backend: BackendId) => {
    if (backend === 'cloud' && !props.cloud) {
      props.configure()
      return
    }
    props.command(backend, { kind: 'new' })
  }
  return (
    <aside className="sidebar backend-workbench-sidebar" aria-label={t('projects')}>
      <div className="brand">
        <span className="agnes-mark" aria-hidden="true" />
        <strong>{t('brand')}</strong>
      </div>
      <Button appearance="primary" className="backend-new-conversation" onClick={() => create(props.active)}>
        <Icon name="plus" />
        {t('create')}
      </Button>
      <nav className="home-entries">
        {(['plugins', 'agents', 'automation', 'mhs'] as const).map((page) => (
          <Button
            key={page}
            appearance="ghost"
            className="home-entry"
            onClick={() => props.command(props.active, { kind: 'home', page })}
          >
            <Icon
              name={
                page === 'plugins'
                  ? 'puzzle'
                  : page === 'agents'
                    ? 'bot'
                    : page === 'automation'
                      ? 'clock'
                      : 'route'
              }
            />
            {t(page)}
          </Button>
        ))}
      </nav>
      <SettingsInput
        aria-label={t('search')}
        placeholder={t('search')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <section className="backend-projects" aria-label={t('projects')}>
        <h2>{t('projects')}</h2>
        {(['local', 'cloud'] as const).map((backend) => {
          const state = props.states[backend]
          const configured = backend === 'local' || Boolean(props.cloud)
          const rows =
            state?.rows.filter((row) =>
              `${row.title} ${row.cwd ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
            ) ?? []
          return (
            <div key={backend} className="backend-session-group" data-backend-group={backend}>
              <Disclosure
                variant="plain"
                open={open[backend]}
                onOpenChange={(value) => setOpen((current) => ({ ...current, [backend]: value }))}
                summary={
                  <span className="backend-group-summary">
                    {t(backend)} <span className="backend-session-count">{state?.rows.length ?? 0}</span>
                    {backend === 'cloud' && (
                      <CloudConnectionIndicator
                        compact
                        status={cloudConnectionState(props.cloud, state).status}
                        t={t}
                      />
                    )}
                  </span>
                }
                summaryProps={{ 'data-testid': `backend-group-${backend}`, 'aria-label': t(backend) }}
              >
                {!configured && <p className="backend-group-hint">{t('unconfigured')}</p>}
                {configured && !state && <p className="backend-group-hint">{t('connecting')}</p>}
                {state?.error && (
                  <div className="backend-group-error" role="status">
                    <p>{state.error}</p>
                  </div>
                )}
                {state?.connected && rows.length === 0 && <p className="backend-group-hint">{t('empty')}</p>}
                <div className="backend-session-list">
                  {rows.map((row) => {
                    const activity = state?.activity.find((item) => item.sessionId === row.sessionId)
                    const selected = props.active === backend && state?.selected === row.sessionId
                    return (
                      <Button
                        key={backendSessionKey(backend, row.sessionId)}
                        appearance="ghost"
                        className="backend-session-row"
                        aria-current={selected ? 'page' : undefined}
                        data-session-id={row.sessionId}
                        data-testid={`backend-session-${backend}`}
                        title={row.cwd ?? row.title}
                        onClick={() => props.select(backend, row.sessionId)}
                      >
                        <Icon name="message-square" />
                        <span className="backend-session-title">{row.title || t('untitled')}</span>
                        {activity && activity.state !== 'idle' && (
                          <span
                            className="backend-session-activity"
                            data-state={activity.state}
                            title={t(activity.state === 'running' ? 'running' : 'waiting')}
                          >
                            ●
                          </span>
                        )}
                      </Button>
                    )
                  })}
                </div>
                {state?.more && (
                  <Button appearance="link" onClick={() => props.command(backend, { kind: 'more' })}>
                    {t('more')}
                  </Button>
                )}
              </Disclosure>
              <Button
                appearance="ghost"
                size="small"
                className="backend-group-create"
                aria-label={t(backend === 'local' ? 'createLocal' : 'createCloud')}
                onClick={() => create(backend)}
              >
                <Icon name="plus" />
              </Button>
            </div>
          )
        })}
      </section>
      <div className="backend-sidebar-footer">
        <Button
          appearance="ghost"
          onClick={() =>
            props.command(
              props.active === 'cloud' && !props.states.cloud?.connected ? 'local' : props.active,
              { kind: 'settings', section: 'model' },
            )
          }
        >
          <Icon name="settings" />
          {t('settings')}
        </Button>
      </div>
    </aside>
  )
}
