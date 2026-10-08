import type { PackageCatalogDescriptor, PackageInstalledDescriptor } from '@agnes/protocol'
import { Badge, Button, SettingsCard, SettingsState } from '@agnes/web-ui'
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
      <p>{t('examplesHelp')}</p>
      {busy && <SettingsState tone="loading">{t('loading')}</SettingsState>}
      {failed && <SettingsState tone="error">{t('unavailable')}</SettingsState>}
      {!busy && !failed && !rows.length && <p>{t('noExamples')}</p>}
      <Button disabled={!api || busy} onClick={() => setRevision((value) => value + 1)}>
        {t('retry')}
      </Button>
      <div className="runtime-grid">
        {rows.map((row) => {
          const name = row.id.split('/').at(-1) ?? row.id
          const labelKey = `example.name.${name}`
          const label = t(labelKey)
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
              <h3>{label === labelKey ? row.id : label}</h3>
              <small>
                {row.id} · {row.version}
              </small>
              <p>{t(row.id.startsWith('@agnes-fde/') ? 'example.summary.fde' : `example.summary.${name}`)}</p>
              <section className="agnes-settings-actions" aria-label={t('exampleSummary')}>
                {row.kinds?.map((kind) => (
                  <Badge key={kind}>{t(`kind.${kind}`)}</Badge>
                ))}
              </section>
              <p>
                {row.version} · {row.license}
              </p>

              {enabled && (
                <p>
                  <Badge tone={available ? 'ok' : 'warn'}>{t('exampleReady')}</Badge>{' '}
                  {t(available ? 'exampleHint' : 'examplePending')}
                </p>
              )}
              <Button
                data-testid={`example-install-${name}`}
                disabled={!api || !canInstall || busy || enabled}
                type={enabled ? 'default' : 'primary'}
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
