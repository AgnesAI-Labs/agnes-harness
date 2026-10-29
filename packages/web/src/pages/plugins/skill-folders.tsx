import type { SkillScanReport } from '@agnes/protocol'
import { contextRequest } from '@agnes/web-admin/settings/context'
import {
  Button,
  Field,
  reportSuccess,
  SettingsDetails,
  SettingsTextArea,
  SettingsToolbar,
  StatusMessage,
} from '@agnes/web-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { SkillScanFeedback } from './skill-scan-feedback.js'

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string
type Config = NonNullable<Parameters<typeof contextRequest>[0]['config']>

const lines = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

/**
 * Extra folders to scan for skills, beside the workspace and personal ones. The list is part of
 * the context configuration; saving writes that configuration back whole, with only this list changed.
 */
export function SkillFolders({
  t,
  canSave,
  onSaved,
  scanReport,
}: {
  t: Text
  canSave: boolean
  onSaved(): Promise<SkillScanReport | undefined>
  scanReport?: SkillScanReport | undefined
}) {
  const [config, setConfig] = useState<Config>()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [scanFailed, setScanFailed] = useState<'scanFailed' | 'cancelled'>()
  const [attempted, setAttempted] = useState(false)
  const [report, setReport] = useState<SkillScanReport>()
  const scanningNow = useRef(false)
  const lifetime = useRef(0)
  useEffect(() => {
    if (!scanningNow.current) setReport(scanReport)
  }, [scanReport])
  useEffect(
    () => () => {
      lifetime.current++
    },
    [],
  )
  const read = useCallback(async (signal?: AbortSignal) => {
    setFailed(false)
    try {
      const value = await contextRequest({}, fetch, signal)
      if (signal?.aborted) return
      setConfig(value.config)
      setDraft(value.config.customSkillRoots.join('\n'))
    } catch {
      if (!signal?.aborted) setFailed(true)
    }
  }, [])
  useEffect(() => {
    const pending = new AbortController()
    void read(pending.signal)
    return () => pending.abort()
  }, [read])
  const current = config?.customSkillRoots ?? []
  const next = lines(draft)
  const changed = next.join('\n') !== current.join('\n')
  const relative = next.some((path) => !/^(?:\/|[A-Za-z]:[\\/]|~[\\/])/.test(path))
  const scan = async () => {
    const generation = lifetime.current
    scanningNow.current = true
    setScanning(true)
    setScanFailed(undefined)
    setAttempted(true)
    try {
      const value = await onSaved()
      if (generation === lifetime.current) setReport(value)
    } catch (error) {
      if (generation === lifetime.current)
        setScanFailed(
          error && typeof error === 'object' && 'code' in error && error.code === 'SKILL_SCAN_CANCELLED'
            ? 'cancelled'
            : 'scanFailed',
        )
    } finally {
      scanningNow.current = false
      if (generation === lifetime.current) setScanning(false)
    }
  }
  const save = async () => {
    if (!canSave || !config || busy || relative) return
    const generation = lifetime.current
    setBusy(true)
    setFailed(false)
    try {
      const value = await contextRequest({ config: { ...config, customSkillRoots: next } })
      if (generation !== lifetime.current) return
      setConfig(value.config)
      setDraft(value.config.customSkillRoots.join('\n'))
      setReport(undefined)
      reportSuccess('skill-folders', t('folders.saved'))
      await scan()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingsDetails
      title={t('folders.title')}
      icon="folder"
      summary={config ? t('folders.count', { count: current.length }) : undefined}
      data-testid="skill-folders"
    >
      <Field
        label={t('folders.label')}
        htmlFor="skill-folders-paths"
        hint={t('folders.help')}
        error={relative ? t('folders.absolute') : undefined}
      >
        <SettingsTextArea
          id="skill-folders-paths"
          data-testid="context-skill-roots"
          rows={3}
          spellCheck={false}
          value={draft}
          disabled={!canSave || !config || busy || scanning}
          placeholder={t('folders.placeholder')}
          onChange={(event) => {
            setDraft(event.currentTarget.value)
          }}
        />
      </Field>
      <SettingsToolbar>
        <Button
          appearance="primary"
          loading={busy}
          data-testid="skill-folders-save"
          aria-describedby="skill-folders-scan-effect"
          disabled={!canSave || !config || busy || scanning || !changed || relative}
          onClick={() => void save()}
        >
          {t('folders.save')}
        </Button>
      </SettingsToolbar>
      <p id="skill-folders-scan-effect" data-testid="skill-folders-scan-effect">
        {t('folders.scanEffect')}
      </p>
      {config && (
        <SkillScanFeedback
          report={report}
          roots={current}
          changed={changed}
          attempted={attempted}
          scanning={scanning}
          failed={scanFailed}
          canScan={canSave && !busy}
          onRetry={() => void scan()}
          t={t}
        />
      )}
      {failed && (
        <StatusMessage
          kind="error"
          action={{
            label: t('folders.retry'),
            onSelect: () => {
              void (config ? save() : read())
            },
            busy,
          }}
        >
          {t('folders.failed')}
        </StatusMessage>
      )}
    </SettingsDetails>
  )
}
