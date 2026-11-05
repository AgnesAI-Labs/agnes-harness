import type { PackageListResult } from '@agnes/protocol'
import {
  Badge,
  Button,
  Icon,
  IconButton,
  ListRow,
  Menu,
  MetaText,
  PluginPrimaryStatus,
  PushPage,
  SettingsDetails,
  SettingsList,
  SettingsState,
  SettingsToolbar,
  StateSwitch,
  usePushStack,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import type { PluginView } from './admin-view.js'
import { ExternalOperationResult } from './external-operation-result.js'
import { openPlugins, pluginPage, pluginPageId } from './route.js'

type ExternalPackage = NonNullable<PackageListResult['externalPackages']>[number]
type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string

export function filteredExternalPackages(view: PluginView, source: string) {
  return (view.state.externalPackages ?? []).filter((item) => {
    const local = ['file', 'path', 'workspace', 'local'].includes(item.source.type)
    const query = view.query.toLocaleLowerCase()
    return (
      (!source || source === (local ? 'local' : 'community')) &&
      (!view.kind ||
        (view.kind === 'mcp' && item.resources.some((row) => row.kind === 'mcp')) ||
        (view.kind === 'skills' && item.resources.some((row) => row.kind === 'skill'))) &&
      (!query ||
        `${item.name} ${item.description ?? ''} ${item.resources.map((row) => row.name).join(' ')}`
          .toLocaleLowerCase()
          .includes(query))
    )
  })
}
export function ExternalPackageRows({
  rows,
  t,
  view,
}: {
  rows: readonly ExternalPackage[]
  t: Text
  view: PluginView
}) {
  const pages = usePushStack()
  const open = (
    item: ExternalPackage,
    kind: 'external' | 'external-enable' | 'external-disable' = 'external',
  ) => pages.open(pluginPageId({ kind, id: item.id }))
  return rows.map((item) => (
    <ListRow
      key={item.id}
      className="plugin-row"
      data-testid="external-plugin-row"
      data-plugin-id={item.id}
      title={item.name}
      titleClassName="plugin-details-button"
      icon={<Icon name="puzzle" size={20} />}
      description={item.description || t('external.summary')}
      meta={t('external.contents', {
        mcp: item.resources.filter((row) => row.kind === 'mcp').length,
        skills: item.resources.filter((row) => row.kind === 'skill').length,
      })}
      status={
        <>
          <Badge>
            {t(
              ['path', 'file', 'local', 'workspace'].includes(item.source.type)
                ? 'source.local'
                : 'source.community',
            )}
          </Badge>
          <PluginPrimaryStatus
            status={item.primaryStatus}
            action={{
              disabled:
                !view.canEffect('packages.activate') ||
                !view.canEffect('packages.install') ||
                !view.state.inventoryAuthoritative ||
                item.result.state === 'running',
              run: () => open(item, 'external-enable'),
            }}
          />
        </>
      }
      onOpen={() => open(item)}
      actions={
        <>
          <div className="plugin-row-actions">
            <StateSwitch
              label={t(item.desired === 'disabled' ? 'external.enable' : 'external.disable', {
                name: item.name,
              })}
              checked={item.desired === 'enabled' || item.desired === 'mixed'}
              busy={item.result.state === 'running'}
              disabled={
                !view.canEffect('packages.activate') ||
                !view.canEffect('packages.install') ||
                item.result.state === 'running' ||
                !view.state.inventoryAuthoritative
              }
              onToggle={(next) => open(item, next ? 'external-enable' : 'external-disable')}
            />
          </div>
          <Menu
            label={t('external.actions')}
            trigger={<IconButton name="ellipsis" label={t('external.actions')} />}
            items={[
              { id: 'details', label: t('external.details'), onSelect: () => open(item) },
              {
                id: 'uninstall',
                label: t('external.uninstall'),
                danger: true,
                disabled: !view.canEffect('packages.remove'),
                onSelect: () => open(item),
              },
            ]}
          />
        </>
      }
    />
  ))
}

export function ExternalPackagePages({ view, t }: { view: PluginView | undefined; t: Text }) {
  const pages = usePushStack()
  const segment = pages.stack.at(-1),
    page = segment ? pluginPage(segment) : undefined
  if (page?.kind !== 'external' || !segment || !view) return null
  const item = view.state.externalPackages?.find((row) => row.id === page.id)
  return (
    <PushPage id={segment} title={item?.name ?? t('external.package')}>
      {item ? (
        <ExternalPackageDetail key={item.id} item={item} view={view} t={t} />
      ) : (
        <SettingsState tone={view.state.loading ? 'loading' : 'empty'}>
          {t(view.state.loading ? 'external.loading' : 'external.missing')}
        </SettingsState>
      )}
    </PushPage>
  )
}

function ExternalPackageDetail({ item, view, t }: { item: ExternalPackage; view: PluginView; t: Text }) {
  const pages = usePushStack()
  const [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [result, setResult] = useState(item.result)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    if (!busy) setResult(item.result)
  }, [busy, item.result])
  const refresh = useRef(view.refresh)
  refresh.current = view.refresh
  useEffect(() => {
    if (busy || item.result.state !== 'running') return
    let mounted = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        await refresh.current()
      } finally {
        if (mounted) timer = setTimeout(() => void poll().catch(() => undefined), 1000)
      }
    }
    timer = setTimeout(() => void poll().catch(() => undefined), 1000)
    return () => {
      mounted = false
      clearTimeout(timer)
    }
  }, [busy, item.result.state])
  const canRemove = view.canEffect('packages.remove') && view.canEffect('packages.install')
  const uninstall = async () => {
    if (!view.api || busy || !item.result.digest) return
    if (!confirmed) {
      setConfirmed(true)
      return
    }
    setBusy(true)
    setError('')
    try {
      let next = await view.api.skillImport({
        action: 'uninstall',
        proposalId: item.id,
        expectedDigest: item.result.digest,
      })
      while (alive.current && next.state === 'running') {
        setResult(next)
        await new Promise((done) => setTimeout(done, 700))
        if (!alive.current) return
        next = await view.api.skillImport({ action: 'status', proposalId: item.id })
      }
      if (!alive.current) return
      setResult(next)
      window.dispatchEvent(new Event('agnes:plugins-invalidated'))
      await view.refresh()
      if (alive.current && next.state === 'cancelled') pages.back()
    } catch {
      if (alive.current) setError(t('external.failed'))
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  return (
    <section data-testid="external-plugin-detail" aria-busy={busy}>
      <MetaText>
        {t('external.package')} · {t(`external.state.${result.state}`)}
      </MetaText>
      {item.description && <p>{item.description}</p>}
      <dl className="community-market-facts">
        <div>
          <dt>{t('external.version')}</dt>
          <dd>{item.version ?? t('external.pinnedVersion')}</dd>
        </div>
        {item.installedAt && (
          <div>
            <dt>{t('external.installedAt')}</dt>
            <dd>{new Date(item.installedAt).toLocaleString()}</dd>
          </div>
        )}
      </dl>
      <h3>{t('external.resources')}</h3>
      <ExternalOperationResult activation={result.activation} t={t} />
      <p>{t('external.manageHelp')}</p>
      <SettingsList>
        {item.resources.map((row) => (
          <ListRow
            key={row.resourceId}
            title={row.name}
            meta={`${row.kind === 'mcp' ? 'MCP' : 'Skill'} · ${t(`external.resource.${row.state}`)}`}
            status={
              <MetaText>
                {row.desired ? t(`external.desired.${row.desired}`) : ''}
                {row.actual
                  ? ` · ${t(`external.actual.${row.actual}`) === `external.actual.${row.actual}` ? row.actual : t(`external.actual.${row.actual}`)}`
                  : ''}
              </MetaText>
            }
            actions={
              <Button
                disabled={
                  busy || row.state === 'missing' || row.state === 'removed' || row.state === 'unknown'
                }
                onClick={() => {
                  openPlugins(row.kind === 'mcp' ? 'mcp' : 'skills')
                  pages.open(pluginPageId({ kind: row.kind, id: row.resourceId }))
                }}
              >
                {t('external.manage')}
              </Button>
            }
          />
        ))}
      </SettingsList>
      <SettingsDetails title={t('external.source')}>
        <p className="external-plugin-source">{item.source.ref}</p>
        <MetaText>{item.result.sourceDigest}</MetaText>
        <MetaText>{item.result.digest}</MetaText>
      </SettingsDetails>
      {(error || result.message) && (
        <SettingsState tone="error">{error || t(`skill.import.reason.${result.message}`)}</SettingsState>
      )}
      {confirmed && <SettingsState tone="error">{t('external.uninstallHelp')}</SettingsState>}
      <SettingsToolbar>
        <Button disabled={busy} onClick={() => pages.back()}>
          {t('external.back')}
        </Button>
        <Button disabled={busy} onClick={() => void view.refresh()}>
          {t('external.refresh')}
        </Button>
        <Button
          disabled={busy || !canRemove || !item.result.digest || result.state === 'running'}
          onClick={() => void uninstall()}
        >
          {t(busy ? 'external.removing' : confirmed ? 'external.confirmUninstall' : 'external.uninstall')}
        </Button>
      </SettingsToolbar>
    </section>
  )
}
