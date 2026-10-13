import { contextRequest } from '@agnes/web-admin/settings/context'
import {
  Button,
  Field,
  SettingsDetails,
  SettingsState,
  SettingsTextArea,
  SettingsToolbar,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'

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
export function SkillFolders({ t, onSaved }: { t: Text; onSaved(): void }) {
  const [config, setConfig] = useState<Config>()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    const pending = new AbortController()
    void contextRequest({}, fetch, pending.signal)
      .then((value) => {
        if (pending.signal.aborted) return
        setConfig(value.config)
        setDraft(value.config.customSkillRoots.join('\n'))
      })
      .catch(() => {
        if (!pending.signal.aborted) setFailed(true)
      })
    return () => pending.abort()
  }, [])
  const current = config?.customSkillRoots ?? []
  const next = lines(draft)
  const changed = next.join('\n') !== current.join('\n')
  const relative = next.some((path) => !/^(?:\/|[A-Za-z]:[\\/]|~[\\/])/.test(path))
  const save = async () => {
    if (!config || busy) return
    setBusy(true)
    setFailed(false)
    setSaved(false)
    try {
      const value = await contextRequest({ config: { ...config, customSkillRoots: next } })
      setConfig(value.config)
      setDraft(value.config.customSkillRoots.join('\n'))
      setSaved(true)
      onSaved()
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
          disabled={!config || busy}
          placeholder={t('folders.placeholder')}
          onChange={(event) => {
            setDraft(event.currentTarget.value)
            setSaved(false)
          }}
        />
      </Field>
      <SettingsToolbar>
        <Button
          appearance="primary"
          data-testid="skill-folders-save"
          disabled={!config || busy || !changed || relative}
          onClick={() => void save()}
        >
          {t('folders.save')}
        </Button>
      </SettingsToolbar>
      {failed && (
        <SettingsState tone="error" role="alert">
          {t('folders.failed')}
        </SettingsState>
      )}
      {saved && <SettingsState tone="success">{t('folders.saved')}</SettingsState>}
    </SettingsDetails>
  )
}
