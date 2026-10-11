import type { PackageCatalogDescriptor, PackageInstalledDescriptor } from '@agnes/protocol'
import { resolvePluginMetadata } from '@agnes/protocol'
import {
  MetaText,
  IconButton,
  SettingsDetails,
  Button,
  PLUGIN_PRESENTATION_NAMESPACE,
  pluginPresentationCatalog,
  SettingsCard,
  SettingsState,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import type { PluginAdminApi } from '../admin/plugins/api.js'
import { sessionStartUrl } from './runtime-panels.js'

/** Use the daemon's discoverable example inventory, not browser filesystem paths. */
export function ExamplesPanel({
  api,
  canInstall = false,
  installed,
  t,
  onReview,
  onBundles,
}: {
  api: PluginAdminApi | undefined
  canInstall?: boolean
  installed: readonly PackageInstalledDescriptor[]
  t(key: string): string
  onReview(item: PackageCatalogDescriptor): void
  onBundles(): void
}) {
  const { locale, t: purposeText } = useUiText(PLUGIN_PRESENTATION_NAMESPACE, pluginPresentationCatalog)
  const [rows, setRows] = useState<PackageCatalogDescriptor[]>([])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision requests a new catalog read.
  useEffect(() => {
    let current = true
    setRows([])
    setFailed(false)
    if (!api) return
    const catalogApi = api
    setBusy(true)
    async function read() {
      const result: PackageCatalogDescriptor[] = []
      let cursor: string | undefined
      let pages = 0
      do {
        pages += 1
        const page = await catalogApi.catalog(undefined, cursor)
        result.push(
          ...page.items.filter(
            (row) =>
              row.sourceId === 'official-examples' || row.source.ref.startsWith('file:./bundled-examples/'),
          ),
        )
        cursor = page.nextCursor ?? undefined
      } while (cursor && current && result.length < 256 && pages < 32)
      if (current) setRows(result)
    }
    void read()
      .catch(() => {
        if (current) setFailed(true)
      })
      .finally(() => {
        if (current) setBusy(false)
      })
    return () => {
      current = false
    }
  }, [api, revision])
  return (
    <section aria-busy={busy}>
      <h3>{t('examples')}</h3>
      <p>{t('examplesHelp')}</p>
      {busy && <SettingsState tone="loading">{t('loading')}</SettingsState>}
      {failed && <SettingsState tone="error">{t('unavailable')}</SettingsState>}
      {!busy && !failed && !rows.length && <p>{t('noExamples')}</p>}
      {failed && (
        <IconButton
          name="refresh-cw"
          label={t('retry')}
          disabled={!api || busy}
          onClick={() => setRevision((value) => value + 1)}
        />
      )}
      <div className="runtime-grid">
        {rows.map((row) => {
          const name = row.id.split('/').at(-1) ?? row.id
          const purpose = resolvePluginMetadata(row.metadata, locale)
          const current = installed.find((pkg) => pkg.id === row.id)
          const enabled = current?.desired === 'enabled'
          const available = enabled && current?.actual === 'running'
          const loop =
            row.id === '@agnes-example/dag-loop'
              ? { id: 'example.dag', version: '1.0.0' }
              : row.id === '@agnes-example/react-loop'
                ? { id: 'example.react', version: '1.0.0' }
                : row.id === '@community/dag-loop-adapter'
                  ? { id: 'community.dag', version: '1.0.0' }
                  : undefined
          return (
            <SettingsCard
              key={`${row.id}@${row.version}`}
              className="runtime-card"
              data-testid={`example-${row.id}`}
            >
              <h3>{purpose?.displayName ?? row.id}</h3>
              {purpose?.summary && <p>{purpose.summary}</p>}
              <MetaText>
                {purposeText('origin.example')}
                {row.metadata ? ` · ${purposeText(`category.${row.metadata.category}`)}` : ''}
              </MetaText>
              <SettingsDetails title={purposeText('technical')}>
                <p>
                  {row.id} · {row.version} · {row.license}
                </p>
                <section className="agnes-settings-actions" aria-label={t('exampleSummary')}>
                  {row.kinds?.map((kind) => (
                    <MetaText key={kind}>{t(`kind.${kind}`)}</MetaText>
                  ))}
                </section>
              </SettingsDetails>
              {enabled && !available && <p>{t('examplePending')}</p>}
              <Button
                data-testid={`example-install-${name}`}
                disabled={!api || !canInstall || busy || enabled}
                disabledReason={enabled ? t('exampleReady') : t('unavailable')}
                onClick={() => onReview(row)}
              >
                {t(enabled ? 'exampleReady' : current ? 'exampleEnable' : 'exampleInstall')}
              </Button>
              {enabled && (
                <Button
                  data-testid={`example-start-${name}`}
                  disabled={!available}
                  href={sessionStartUrl(
                    undefined,
                    undefined,
                    row.kinds?.includes('bundle') ? [name] : [],
                    loop,
                  )}
                >
                  {t('exampleStart')}
                </Button>
              )}
            </SettingsCard>
          )
        })}
      </div>
      <Button onClick={onBundles}>{t('chooseBundle')}</Button>
    </section>
  )
}
