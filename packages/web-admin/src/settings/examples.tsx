import type { PackageCatalogDescriptor, PackageInstalledDescriptor } from '@agnes/protocol'
import { resolvePluginMetadata } from '@agnes/protocol'
import { homeNavigation } from '@agnes/web-client'
import {
  Button,
  IconButton,
  MetaText,
  PLUGIN_PRESENTATION_NAMESPACE,
  pluginPresentationCatalog,
  SettingsCard,
  SettingsDetails,
  SettingsState,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import type { PluginAdminApi } from '../admin/plugins/api.js'
import { exampleDiscovery } from '../agents/discovery.js'

type ExampleCardsProps = {
  api: PluginAdminApi | undefined
  canInstall?: boolean
  installed: readonly PackageInstalledDescriptor[]
  t(key: string): string
  onReview(item: PackageCatalogDescriptor): void
}
/** The registry mounts this introduction once above the discover catalog. */
export function ExamplesPanel(props: ExampleCardsProps & { onBundles(): void }) {
  const { t } = useUiText(PLUGIN_PRESENTATION_NAMESPACE, pluginPresentationCatalog)
  return (
    <section>
      <h3>{t('examples.title')}</h3>
      <p>{props.t('examplesHelp')}</p>
      <OfficialExampleCards {...props} />
      <Button onClick={props.onBundles}>{props.t('chooseBundle')}</Button>
    </section>
  )
}
/** Reusable discover content consumes the daemon catalog, never browser filesystem paths. */
export function OfficialExampleCards({ api, canInstall = false, installed, t, onReview }: ExampleCardsProps) {
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
        result.push(...page.items.filter((row) => !row.metadata?.exampleOf && exampleDiscovery(row).featured))
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
  const exampleCards = rows.map((row) => {
    const name = row.id.split('/').at(-1) ?? row.id
    const purpose = resolvePluginMetadata(row.metadata, locale)
    const current = installed.find((pkg) => pkg.id === row.id)
    const enabled = current?.desired === 'enabled'
    const available = enabled && current?.actual === 'running'
    return (
      <SettingsCard
        key={`${row.id}@${row.version}`}
        className="runtime-card"
        data-testid={`example-${row.id}`}
      >
        <h3>{purpose?.displayName ?? row.id}</h3>
        {purpose?.summary && <p>{purpose.summary}</p>}
        <MetaText>{purposeText('origin.example')}</MetaText>
        <SettingsDetails title={purposeText('technical')}>
          <p>
            {row.id} · {row.version} · {row.license}
          </p>
          <section className="agnes-settings-actions" aria-label={t('exampleSummary')}>
            {row.provides?.map((kind) => (
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
            onClick={() =>
              homeNavigation.open(
                'agents',
                row.agents?.length === 1 ? { agent: row.agents[0]!.ref, start: true } : undefined,
              )
            }
          >
            {t('exampleStart')}
          </Button>
        )}
      </SettingsCard>
    )
  })
  return (
    <section className="plugin-examples" aria-busy={busy}>
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
      <div className="runtime-grid">{exampleCards.slice(0, 3)}</div>
      {exampleCards.length > 3 && (
        <SettingsDetails title={purposeText('examples.more')} data-testid="example-more">
          <div className="runtime-grid">{exampleCards.slice(3)}</div>
        </SettingsDetails>
      )}
    </section>
  )
}
