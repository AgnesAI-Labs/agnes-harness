import type { PackageListResult, SkillImportResult } from '@agnes/protocol'
import {
  Button,
  ListRow,
  MetaText,
  PushPage,
  SettingsCheckbox,
  SettingsList,
  SettingsState,
  SettingsToolbar,
  usePushStack,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import type { PluginView } from './admin-view.js'
import { ExternalOperationResult, externalIssueText } from './external-operation-result.js'
import { openPlugins, pluginPage, pluginPageId } from './route.js'

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string
type Package = NonNullable<PackageListResult['externalPackages']>[number]

export function ExternalLifecyclePage({ view, t }: { view: PluginView | undefined; t: Text }) {
  const pages = usePushStack(),
    segment = pages.stack.at(-1),
    page = segment ? pluginPage(segment) : undefined
  if (!view || !segment || (page?.kind !== 'external-enable' && page?.kind !== 'external-disable'))
    return null
  const item = view.state.externalPackages?.find((row) => row.id === page.id)
  const enable = page.kind === 'external-enable'
  return (
    <PushPage
      id={segment}
      title={t(enable ? 'external.enable' : 'external.disable', { name: item?.name ?? page.id })}
    >
      {item ? (
        <LifecycleReview key={segment} item={item} enable={enable} view={view} t={t} />
      ) : (
        <SettingsState>{t(view.state.loading ? 'external.loading' : 'external.missing')}</SettingsState>
      )}
    </PushPage>
  )
}

function LifecycleReview({
  item,
  enable,
  view,
  t,
}: {
  item: Package
  enable: boolean
  view: PluginView
  t: Text
}) {
  const [result, setResult] = useState<SkillImportResult>(),
    [busy, setBusy] = useState(false)
  const [trust, setTrust] = useState(false),
    [error, setError] = useState('')
  const alive = useRef(true),
    pages = usePushStack(),
    api = view.api
  const run = async (checking: boolean, target = { id: item.id, enable }) => {
    if (!api || !item.result.digest) return
    setBusy(true)
    setError('')
    if (checking) {
      setTrust(false)
      setResult(undefined)
    }
    try {
      let next = await api.skillImport({
        action: checking ? 'activation-check' : target.enable ? 'enable' : 'disable',
        proposalId: target.id,
        expectedDigest: item.result.digest,
        ...(checking
          ? { enable: target.enable }
          : {
              ...(result?.activation?.digest ? { expectedActivationDigest: result.activation.digest } : {}),
              trustResources: trust,
            }),
      })
      while (alive.current && next.state === 'running') {
        setResult(next)
        await new Promise((done) => setTimeout(done, 500))
        if (!alive.current) return
        next = await api.skillImport({ action: 'status', proposalId: target.id })
      }
      if (!alive.current) return
      setResult(next)
      if (!checking) {
        window.dispatchEvent(new Event('agnes:plugins-invalidated'))
        await view.refresh()
        if (alive.current && next.state === 'installed' && !next.phase?.startsWith('partially-')) {
          pages.back()
        }
      }
    } catch {
      if (alive.current) setError(t('external.failed'))
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const request = useRef(run)
  const latestResult = useRef(item.result)
  request.current = run
  latestResult.current = item.result
  useEffect(() => {
    if (!api) return
    alive.current = true
    const persisted = latestResult.current
    // Reopening a terminal result must not erase its persisted outcomes with an implicit check.
    if (
      persisted.state !== 'running' &&
      persisted.activation?.outcomes?.length &&
      persisted.activation.enable === enable
    )
      setResult(persisted)
    else void request.current(true, { id: item.id, enable })
    return () => {
      alive.current = false
    }
  }, [api, item.id, enable])
  const preview = result?.activation
  const eligible = preview?.resources.filter((row) => !row.issues?.length) ?? []
  const needsTrust = enable && !preview?.outcomes && eligible.some((row) => row.trust !== 'trusted')
  const canConfirm =
    view.canEffect('packages.activate') &&
    view.canEffect('packages.install') &&
    eligible.some((row) => !enable || row.trust === 'trusted' || (trust && view.canEffect('packages.trust')))
  return (
    <section data-testid="external-lifecycle-review" aria-busy={busy} aria-live="polite">
      <p>{t(enable ? 'external.enableHelp' : 'external.disableHelp')}</p>
      {enable && !preview?.outcomes && <MetaText>{t('external.providerSetup')}</MetaText>}
      <pre className="external-lifecycle-launch">
        {[item.version, item.source.ref].filter(Boolean).join(' · ')}
      </pre>
      {busy && (
        <SettingsState tone="loading">
          {t(result?.phase === 'checking-activation' || !result ? 'external.checking' : 'external.applying')}
        </SettingsState>
      )}
      {(error || result?.message) && (
        <SettingsState tone="error">{error || t(`skill.import.reason.${result?.message}`)}</SettingsState>
      )}
      {preview?.errorCode && !preview.outcomes && (
        <SettingsState tone="error">
          {t(`mcp.import.error.${preview.errorCode}`) === `mcp.import.error.${preview.errorCode}`
            ? preview.errorCode
            : t(`mcp.import.error.${preview.errorCode}`)}
        </SettingsState>
      )}
      {preview && (
        <>
          {!preview.outcomes && (
            <SettingsList>
              {preview.resources.map((row) => (
                <ListRow
                  key={row.resourceId}
                  title={row.name}
                  meta={`${row.kind === 'mcp' ? 'MCP' : 'Skill'} · ${t(`external.desired.${row.desired}`)}`}
                >
                  {row.launch && <pre className="external-lifecycle-launch">{row.launch}</pre>}
                  {row.cwd && (
                    <MetaText>
                      {t('mcp.import.cwd')}: {row.cwd}
                    </MetaText>
                  )}
                  {row.sandboxProfile && (
                    <MetaText>
                      {t('mcp.import.sandbox')}: {t(`mcp.import.sandbox.${row.sandboxProfile}`)}
                    </MetaText>
                  )}
                  <MetaText>
                    {t(row.trust === 'trusted' ? 'external.trusted' : 'external.needsTrust')}
                  </MetaText>
                  {row.issues?.map((issue) => (
                    <SettingsState key={issue} tone="error">
                      {externalIssueText(issue, t)}
                    </SettingsState>
                  ))}
                </ListRow>
              ))}
            </SettingsList>
          )}
          {preview.issues.map((issue) => (
            <SettingsState key={issue} tone="error">
              {t(`skill.import.reason.${issue}`)}
            </SettingsState>
          ))}
          {preview.warnings.map((warning) => (
            <SettingsState key={warning}>{t(`skill.import.reason.${warning}`)}</SettingsState>
          ))}
          {preview.environment.length > 0 && (
            <>
              <h3>{t('skill.import.environment')}</h3>
              <ul>
                {preview.environment.map((row) => (
                  <li key={row.name}>
                    {row.name} {row.required ?? ''} · {t(`skill.import.env.${row.state}`)} {row.actual ?? ''}
                  </li>
                ))}
              </ul>
            </>
          )}
          {needsTrust && (
            <SettingsCheckbox
              checked={trust}
              disabled={busy || !view.canEffect('packages.trust')}
              onChange={(event) => setTrust(event.currentTarget.checked)}
              label={t('external.trustAndEnable')}
            />
          )}
          {!preview.outcomes && !canConfirm && !needsTrust && (
            <MetaText>{t('external.permissionRequired')}</MetaText>
          )}
          <ExternalOperationResult activation={preview} t={t} />
        </>
      )}
      <SettingsToolbar>
        {busy && result?.phase && ['enabling', 'disabling'].includes(result.phase) && (
          <Button
            onClick={() =>
              void api
                ?.skillImport({ action: 'cancel', proposalId: item.id })
                .catch(() => setError(t('external.failed')))
            }
          >
            {t('external.cancelOperation')}
          </Button>
        )}
        {enable && preview?.resources.some((row) => row.kind === 'mcp') && (
          <Button
            disabled={busy}
            onClick={() => {
              const connection = preview.resources.find((row) => row.kind === 'mcp')!
              openPlugins('mcp')
              pages.open(pluginPageId({ kind: 'mcp', id: connection.resourceId }))
            }}
          >
            {t('external.manageConnections')}
          </Button>
        )}
        <Button disabled={busy} onClick={() => pages.back()}>
          {t('external.back')}
        </Button>
        <Button disabled={busy} onClick={() => void run(true)}>
          {t(preview?.outcomes ? 'external.retry' : 'external.recheck')}
        </Button>
        {!preview?.outcomes && (
          <Button
            appearance="primary"
            disabled={
              busy ||
              !preview ||
              !!preview.issues.length ||
              !!preview.outcomes ||
              !canConfirm ||
              result?.state === 'failed' ||
              result?.state === 'interrupted'
            }
            onClick={() => void run(false)}
          >
            {t(enable ? 'external.confirmEnable' : 'external.confirmDisable')}
          </Button>
        )}
      </SettingsToolbar>
    </section>
  )
}
