import { Button, Disclosure, IconButton } from '@agnes/web-ui'
import { type ConversationItemType, Conversations, XProvider } from '@agnes/web-ui/x'
import type { SidebarNavigationOptions } from '@agnes/web-units/shell'
import { useState } from 'react'
import { SessionRowLabel } from '../sidebar-rendering.js'
import { CloudConnectionIndicator } from './cloud-connection-status.js'
import type { BackendCommand, BackendId, BackendSnapshot } from './frame-contract.js'
import type { WorkbenchText } from './workbench-locale.js'
import { cloudConnectionState } from './workbench-state.js'
import { workbenchText } from './workbench-text.js'

export type BackendGroupsProps = {
  active: BackendId
  cloud?: string
  states: Partial<Record<BackendId, BackendSnapshot>>
  t: WorkbenchText
  select(id: BackendId, sessionId?: string): void
  command(id: BackendId, command: BackendCommand): void
  configure(): void
}

export function BackendSessionGroups(props: BackendGroupsProps & { language: string }) {
  const { t } = props
  const [open, setOpen] = useState({ local: true, cloud: true })
  const nativeText = workbenchText(props.language)
  return (
    <>
      {(['local', 'cloud'] as const).map((backend) => {
        const state = props.states[backend]
        const configured = backend === 'local' || Boolean(props.cloud)
        const currentId = props.active === backend ? state?.selected : undefined
        const options: SidebarNavigationOptions = {
          sessions: [],
          workspaces: [],
          labels: new Map(),
          ...(currentId ? { currentId } : {}),
          newSession: () => props.command(backend, { kind: 'new' }),
          open: (id) => props.select(backend, id),
          action: (action, sessionId, title) => {
            if (action !== 'unarchive')
              props.command(backend, { kind: 'session-action', action, sessionId, title })
          },
        }
        const items: ConversationItemType[] = (state?.rows ?? []).map((row) => {
          const activity = state?.activity.find((item) => item.sessionId === row.sessionId)
          return {
            key: row.sessionId,
            className: 'session-row',
            'data-active': String(currentId === row.sessionId),
            'data-testid': `backend-session-${backend}`,
            'data-session-id': row.sessionId,
            label: (
              <SessionRowLabel
                options={options}
                t={nativeText}
                row={row}
                title={row.title || t('untitled')}
                active={currentId === row.sessionId}
                running={activity?.state === 'running'}
                {...(activity?.waiting ? { mark: activity.waiting } : {})}
                pinned={Boolean(row.pinnedAt)}
                pinnedMark={Boolean(row.pinnedAt)}
                archived={false}
                restoring={false}
                chats={false}
              />
            ),
          }
        })
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
                <p className="backend-group-error" role="status">
                  {state.error}
                </p>
              )}
              {state?.connected && !items.length && <p className="backend-group-hint">{t('empty')}</p>}
              <XProvider>
                <Conversations
                  className="session-conversations"
                  {...(currentId ? { activeKey: currentId } : {})}
                  items={items}
                />
              </XProvider>
              {state?.more && (
                <Button
                  appearance="ghost"
                  className="session-list-toggle"
                  onClick={() => props.command(backend, { kind: 'more' })}
                >
                  {t('more')}
                </Button>
              )}
            </Disclosure>
            <IconButton
              className="backend-group-create"
              name="plus"
              label={t(backend === 'local' ? 'createLocal' : 'createCloud')}
              onClick={() =>
                backend === 'cloud' && !props.cloud
                  ? props.configure()
                  : props.command(backend, { kind: 'new' })
              }
            />
          </div>
        )
      })}
    </>
  )
}
