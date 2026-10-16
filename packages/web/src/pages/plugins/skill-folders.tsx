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
import { useCallback, useEffect, useState } from 'react'

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
export function SkillFolders({ t, canSave, onSaved }: { t: Text; canSave: boolean; onSaved(): void }) {
  const [config, setConfig] = useState<Config>()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
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
  const save = async () => {
    if (!canSave || !config || busy || relative) return
    setBusy(true)
    setFailed(false)
    try {
      const value = await contextRequest({ config: { ...config, customSkillRoots: next } })
      setConfig(value.config)
      setDraft(value.config.customSkillRoots.join('\n'))
      reportSuccess('skill-folders', t('folders.saved'), {
        kind: 'rescan-required',
        message: t('folders.rescan'),
        action: { label: t('folders.scan'), onSelect: onSaved },
      })
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
          disabled={!canSave || !config || busy}
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
          disabled={!canSave || !config || busy || !changed || relative}
          onClick={() => void save()}
        >
          {t('folders.save')}
        </Button>
      </SettingsToolbar>
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
