import type { ResourceAdminMount } from '@agnes/resource-control-web/admin'
import { Banner, Button, Icon } from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string

/**
 * Skills and MCP servers. The resource controller owns the list, the detail and the add-server
 * dialog; this tab lends it a list, a status line and the two toolbar buttons it drives.
 */
export function ResourcesTab({
  tab,
  t,
  workspaceId,
}: {
  tab: 'skills' | 'mcp'
  t: Text
  workspaceId: string | undefined
}) {
  const list = useRef<HTMLElement>(null)
  const notice = useRef<HTMLParagraphElement>(null)
  const refresh = useRef<HTMLButtonElement>(null)
  const create = useRef<HTMLButtonElement>(null)
  const mounted = useRef<ResourceAdminMount>()
  const scope = useRef({ tab, workspaceId })
  scope.current = { tab, workspaceId }
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    void import('@agnes/resource-control-web/admin').then(
      ({ mountResourceAdmin }) => {
        if (!alive || !list.current || !notice.current || !refresh.current || !create.current) return
        const current = scope.current
        mounted.current = mountResourceAdmin({
          tab: current.tab,
          ...(current.workspaceId ? { workspaceId: current.workspaceId } : {}),
          surface: {
            list: list.current,
            notice: notice.current,
            refresh: refresh.current,
            create: create.current,
          },
        })
      },
      () => {
        if (alive) setFailed(true)
      },
    )
    return () => {
      alive = false
      const leaving = mounted.current
      mounted.current = undefined
      // The controller unmounts its regions synchronously; let this commit finish first.
      queueMicrotask(() => leaving?.dispose())
    }
  }, [])
  useEffect(() => {
    void mounted.current?.sync(workspaceId ? { tab, workspaceId } : { tab })
  }, [tab, workspaceId])
  return (
    <div className="plugins-page-resources" data-resource-tab={tab}>
      {failed && <Banner tone="error">{t('resource.failed')}</Banner>}
      <div className="plugins-page-toolbar" data-kind="mcp" hidden={tab !== 'mcp'}>
        <p className="agnes-settings-page-description">{t('mcp.description')}</p>
        <div className="resource-toolbar-actions">
          <Button ref={refresh} htmlType="button" size="small" hidden>
            {t('mcp.refreshSkills')}
          </Button>
          <Button
            ref={create}
            htmlType="button"
            appearance="primary"
            data-testid="mcp-create"
            icon={<Icon name="plus" />}
          >
            {t('mcp.add')}
          </Button>
        </div>
      </div>
      <p ref={notice} className="admin-notice" role="status" aria-live="polite" hidden />
      <section ref={list} className="plugin-list" aria-live="polite" />
    </div>
  )
}
