import type { PackageCatalogDescriptor, PackageInstalledDescriptor } from '@agnes/protocol'
import { Badge, Button } from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import type { PluginAdminApi } from '../admin/plugins/api.js'

/** Use the daemon's discoverable example inventory, not browser filesystem paths. */
export function ExamplesPanel({
  api,
  installed,
  t,
  onReview,
  onBundles,
}: {
  api: PluginAdminApi | undefined
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
      do {
        const page = await catalogApi.catalog(undefined, cursor)
        result.push(
          ...page.items.filter((row) => row.source.ref.includes('/fde/') && row.kinds?.includes('bundle')),
        )
        cursor = page.nextCursor ?? undefined
      } while (cursor && current && result.length < 256)
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
      {busy && <p role="status">{t('loading')}</p>}
      {failed && <p role="alert">{t('unavailable')}</p>}
      {!busy && !failed && !rows.length && <p>{t('noExamples')}</p>}
      <Button disabled={!api || busy} onClick={() => setRevision((value) => value + 1)}>
        {t('retry')}
      </Button>
      <div className="runtime-grid">
        {rows.map((row) => (
          <article
            key={`${row.id}@${row.version}`}
            className="runtime-card"
            data-testid={`example-${row.id}`}
          >
            <h3>{row.id}</h3>
            <p>
              {row.version} · {row.license}
            </p>
            <p>{row.source.ref}</p>
            {installed.some((pkg) => pkg.id === row.id && pkg.desired === 'enabled') && (
              <p>
                <Badge tone="ok">{t('exampleReady')}</Badge>
              </p>
            )}
            <Button onClick={() => onReview(row)}>{t('review')}</Button>
          </article>
        ))}
      </div>
      <Button onClick={onBundles}>{t('chooseBundle')}</Button>
    </section>
  )
}
