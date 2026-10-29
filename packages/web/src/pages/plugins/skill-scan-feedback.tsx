import type { SkillScanReport } from '@agnes/protocol'
import { Button, SettingsToolbar, StatusMessage } from '@agnes/web-ui'
import { useEffect, useState } from 'react'

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string
async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
/** Hash only the normalized configuration returned by the context endpoint. */
async function matchFolders(report: SkillScanReport, roots: readonly string[]) {
  if ((await sha256(JSON.stringify(roots))) !== report.configurationRevision) return undefined
  const ids = await Promise.all(roots.map(sha256))
  return roots.map((path, i) => ({
    path,
    scan: report.directories.find((entry) => entry.directoryId === ids[i]),
  }))
}
/** Deliberately select fields: even an unexpected extra property must never reach the clipboard. */
function diagnosticSummary(report: SkillScanReport): string {
  return JSON.stringify(
    {
      operationId: report.operationId,
      generation: report.generation,
      observedAt: report.observedAt,
      configurationRevision: report.configurationRevision,
      complete: report.complete,
      foundCount: report.foundCount,
      skippedCount: report.skippedCount,
      unreadableDirectoryCount: report.unreadableDirectoryCount,
      truncated: report.truncated,
      directories: report.directories.map((entry) => ({
        directoryId: entry.directoryId,
        state: entry.state,
        complete: entry.complete,
        foundCount: entry.foundCount,
        skippedCount: entry.skippedCount,
        unreadable: entry.unreadable,
        truncated: entry.truncated,
        issues: entry.issues.map(({ code, stage, osCode }) => ({
          code,
          stage,
          ...(osCode ? { osCode } : {}),
        })),
      })),
    },
    null,
    2,
  )
}
export function SkillScanFeedback({
  report,
  roots,
  changed,
  attempted,
  scanning,
  failed,
  canScan,
  onRetry,
  t,
}: {
  report?: SkillScanReport | undefined
  roots: readonly string[]
  changed: boolean
  attempted: boolean
  scanning: boolean
  failed?: 'scanFailed' | 'cancelled' | undefined
  canScan: boolean
  onRetry(): void
  t: Text
}) {
  const [matched, setMatched] = useState<Awaited<ReturnType<typeof matchFolders>>>()
  const [checked, setChecked] = useState<SkillScanReport>()
  const [copy, setCopy] = useState<'copied' | 'copyFailed'>()
  useEffect(() => {
    let active = true
    setMatched(undefined)
    setChecked(undefined)
    setCopy(undefined)
    if (report && !changed)
      void matchFolders(report, roots).then(
        (value) => {
          if (active) {
            setMatched(value)
            setChecked(report)
          }
        },
        () => {
          if (active) setChecked(report)
        },
      )
    return () => {
      active = false
    }
  }, [report, roots, changed])
  if (!roots.length && !scanning && !attempted) return null
  const current = checked === report && matched && !changed ? report : undefined
  const checking = !!report && !changed && checked !== report
  const message =
    scanning || checking
      ? 'scanning'
      : failed
        ? failed
        : changed || (report && checked === report && !matched)
          ? 'outdated'
          : !current
            ? attempted
              ? 'noDetails'
              : 'unchecked'
            : undefined
  return (
    <div aria-live="polite" data-testid="skill-scan-feedback">
      {message && (
        <StatusMessage kind={scanning || checking ? 'pending' : failed ? 'error' : 'notice'}>
          {t(`folders.${message}`)}
        </StatusMessage>
      )}
      {current && !scanning && (
        <>
          <p>
            {t(current.complete && !current.skippedCount ? 'folders.scanComplete' : 'folders.scanPartial')}
          </p>
          <p>{t('folders.observedAt', { time: current.observedAt })}</p>
          <p>{t('folders.counts', { found: current.foundCount, skipped: current.skippedCount })}</p>
          {!current.complete && <p>{t('folders.lowerBound')}</p>}
          <p>{t('folders.countMeaning')}</p>
          {current.truncated && <p>{t('folders.truncated')}</p>}
          <ul>
            {matched?.map(({ path, scan }) => (
              <li key={path}>
                <p>
                  <strong>{path}</strong> — {t(`folders.state.${scan?.state ?? 'unchecked'}`)}
                </p>
                {scan && (
                  <>
                    <p>
                      {scan.unreadable
                        ? t('folders.unknownCount')
                        : t('folders.counts', { found: scan.foundCount, skipped: scan.skippedCount })}
                    </p>
                    {[...new Set(scan.issues.map((issue) => issue.code))].map((code) => (
                      <p key={code}>{t(`folders.issue.${code}`)}</p>
                    ))}
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <SettingsToolbar>
        <Button
          data-testid="skill-scan-retry"
          disabled={!canScan || scanning || checking || changed}
          onClick={onRetry}
        >
          {t('folders.scan')}
        </Button>
        {current && (
          <Button
            data-testid="skill-scan-copy"
            disabled={scanning}
            onClick={() => {
              void (navigator.clipboard?.writeText(diagnosticSummary(current)) ?? Promise.reject()).then(
                () => setCopy('copied'),
                () => setCopy('copyFailed'),
              )
            }}
          >
            {t('folders.copy')}
          </Button>
        )}
      </SettingsToolbar>
      {copy && <p role="status">{t(`folders.${copy}`)}</p>}
    </div>
  )
}
