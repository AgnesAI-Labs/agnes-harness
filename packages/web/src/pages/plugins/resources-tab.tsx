import type { SkillScanReport } from '@agnes/protocol'
import type { ResourceAdminMount } from '@agnes/resource-control-web/admin'
import {
  Banner,
  Button,
  Icon,
  setResourcePackageNames,
  setResourceSkillRunner,
  usePushStack,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { usePageProgress } from './admin-view.js'
import { type HostedOpen, HostedPage, useHostedDialog } from './hosted-pages.js'
import { pluginPage, pluginPageId } from './route.js'
import { SkillFolders } from './skill-folders.js'
import { SkillRunPage } from './skill-run.js'

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string

/**
 * Skills and MCP servers. The resource controller owns the list, the detail and the add-server
 * dialog; this tab lends it a list, a status line and the two toolbar buttons it drives.
 */
export function ResourcesTab({
  tab,
  t,
  workspaceId,
  canSave,
  packageName,
}: {
  tab: 'skills' | 'mcp'
  t: Text
  workspaceId: string | undefined
  canSave: boolean
  /** The display name of an installed plugin, so a skill row can say where it comes from. */
  packageName(id: string): string | undefined
}) {
  const names = useRef(packageName)
  names.current = packageName
  // A skill that is on can be run in a new session from its row's menu (this replaces Run skill in settings).
  const pages = usePushStack()
  const openPage = useRef(pages.open)
  openPage.current = pages.open
  useEffect(() => {
    setResourcePackageNames((id) => names.current(id))
    setResourceSkillRunner((name) => openPage.current(pluginPageId({ kind: 'run', id: name })))
    return () => {
      setResourcePackageNames(undefined)
      setResourceSkillRunner(undefined)
    }
  }, [])
  const list = useRef<HTMLElement>(null)
  const notice = useRef<HTMLParagraphElement>(null)
  const refresh = useRef<HTMLButtonElement>(null)
  const create = useRef<HTMLButtonElement>(null)
  const mounted = useRef<ResourceAdminMount>()
  const scope = useRef({ tab, workspaceId })
  if (scope.current.tab !== tab || scope.current.workspaceId !== workspaceId)
    scope.current = { tab, workspaceId }
  const [scanReport, setScanReport] = useState<SkillScanReport>()
  const [failed, setFailed] = useState(false)
  // The controller's first read has finished: a link to one resource can be followed from here.
  const [loadedScope, setLoadedScope] = useState<typeof scope.current>()
  const loaded = loadedScope === scope.current
  usePageProgress(!loaded && !failed)
  useEffect(() => {
    let alive = true
    void import('@agnes/resource-control-web/admin').then(
      ({ mountResourceAdmin }) => {
        if (!alive || !list.current || !notice.current || !refresh.current || !create.current) return
        const current = scope.current
        mounted.current = mountResourceAdmin({
          tab: current.tab,
          onSkillScanReport: (report) => {
            if (alive) setScanReport(report)
          },
          ...(current.workspaceId ? { workspaceId: current.workspaceId } : {}),
          surface: {
            list: list.current,
            notice: notice.current,
            refresh: refresh.current,
            create: create.current,
          },
        })
        void mounted.current.ready.finally(() => {
          if (alive) setLoadedScope(current)
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
    let current = true
    const requestedScope = scope.current
    // Resource sync renders its regions synchronously; begin after this React commit.
    queueMicrotask(() => {
      const controller = mounted.current
      if (current && controller)
        void controller.sync(workspaceId ? { tab, workspaceId } : { tab }).then(() => {
          if (current) setLoadedScope(requestedScope)
        })
    })
    return () => {
      current = false
    }
  }, [tab, workspaceId])
  const kind = tab === 'skills' ? 'skill' : 'mcp'
  const detail = useHostedDialog({
    id: 'resource-detail',
    ready: loaded,
    owns: (segment) => pluginPage(segment)?.kind === kind,
    pageOf: (host) => pluginPageId({ kind, id: host.dataset.resourceId ?? '' }),
    open: (segment): HostedOpen => {
      const page = pluginPage(segment)
      if (!mounted.current || !loaded) return 'pending'
      if (page?.kind !== kind) return 'missing'
      mounted.current.select(page.id)
      // A resource that is not in the list does not open: leave its page instead of showing nothing.
      return document.querySelector<HTMLDialogElement>('#resource-detail')?.open ? 'opened' : 'missing'
    },
  })
  const form = useHostedDialog({
    id: 'mcp-dialog',
    returnFocus: () => create.current,
    ready: loaded,
    owns: (segment) => tab === 'mcp' && segment === 'add-mcp',
    pageOf: () => 'add-mcp',
    open: (): HostedOpen => {
      if (!loaded) return 'pending'
      if (!create.current || create.current.disabled) return 'missing'
      create.current.click()
      return 'opened'
    },
  })
  const title = (segment: string) =>
    segment === 'add-mcp'
      ? (document.getElementById('mcp-dialog-title')?.textContent ?? t('mcp.add'))
      : (detail?.getAttribute('aria-label') ?? '')
  return (
    <div className="plugins-page-resources" data-resource-tab={tab}>
      {pages.stack
        .filter((segment) => (tab === 'mcp' && segment === 'add-mcp') || pluginPage(segment)?.kind === kind)
        .map((segment) => (
          <HostedPage
            key={segment}
            segment={segment}
            host={segment === 'add-mcp' ? form : detail}
            title={title(segment)}
          />
        ))}
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
            disabled
            icon={<Icon name="plus" />}
          >
            {t('mcp.add')}
          </Button>
        </div>
      </div>
      <p ref={notice} className="admin-notice" role="status" aria-live="polite" hidden />
      <section ref={list} className="plugin-list" aria-live="polite" />
      {tab === 'skills' && (
        <SkillFolders
          key={workspaceId ?? 'user'}
          t={t}
          canSave={canSave && loaded}
          scanReport={scanReport}
          onSaved={async () => {
            if (!mounted.current) throw new Error('Resource admin is not connected.')
            return mounted.current.scanSkills()
          }}
        />
      )}
      {pages.stack.map((segment) => {
        const page = pluginPage(segment)
        return page?.kind === 'run' ? <SkillRunPage key={segment} name={page.id} t={t} /> : null
      })}
    </div>
  )
}
