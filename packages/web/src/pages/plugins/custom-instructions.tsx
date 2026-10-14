import type { SystemPromptConfig } from '@agnes/protocol'
import { contextRequest } from '@agnes/web-admin/settings/context'
import { systemPromptApi } from '@agnes/web-admin/settings/system-prompt-api'
import {
  Badge,
  Banner,
  Button,
  Field,
  IconTile,
  ListRow,
  SettingsCard,
  SettingsInput,
  SettingsList,
  SettingsState,
  SettingsTextArea,
  SettingsToolbar,
  Tag,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { HomePageSection } from '../page-frame.js'

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string
const browserApi = systemPromptApi()

/** "Automatic" is a promise; when the setting behind it is off, the row says so instead. */
function Provided({ on, t }: { on: boolean; t: Text }) {
  return on ? <Badge tone="ok">{t('ctx.autoBadge')}</Badge> : <Tag tone="warn">{t('ctx.off')}</Tag>
}

/**
 * What the user wants the agent to do, and how it should reply. The stored shape is unchanged:
 * the large box is the opening instruction, the style line is the reply style, and an existing
 * closing instruction stays editable so nothing saved earlier is lost.
 */
export function CustomInstructions({
  canSave,
  t,
  api = browserApi,
}: {
  canSave: boolean
  t: Text
  api?: ReturnType<typeof systemPromptApi>
}) {
  const [config, setConfig] = useState<SystemPromptConfig>({})
  const [hadClosing, setHadClosing] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(true)
  const [failed, setFailed] = useState(false)
  const [saved, setSaved] = useState(false)
  const [stored, setStored] = useState('{}')
  useEffect(() => {
    const pending = new AbortController()
    void api
      .get(pending.signal)
      .then((value) => {
        if (pending.signal.aborted) return
        setConfig(value.config)
        setStored(JSON.stringify(value.config))
        setHadClosing(!!value.config.personaSuffix)
        setLoaded(true)
      })
      .catch(() => {
        if (!pending.signal.aborted) setFailed(true)
      })
      .finally(() => {
        if (!pending.signal.aborted) setBusy(false)
      })
    return () => pending.abort()
  }, [api])
  const [context, setContext] = useState<{ rulesEnabled: boolean; timeEnabled: boolean; timeZone: string }>()
  useEffect(() => {
    const pending = new AbortController()
    // Optional: without it the rows describe the defaults, which is what a fresh install has.
    void contextRequest({}, fetch, pending.signal)
      .then((value) => {
        if (!pending.signal.aborted) setContext(value.config)
      })
      .catch(() => undefined)
    return () => pending.abort()
  }, [])
  const replaced = !!config.fullOverride
  const locked = !canSave || busy || replaced || !loaded
  const edit = (name: 'personaPrefix' | 'personaSuffix' | 'replyStyle', value: string) => {
    setSaved(false)
    setConfig((previous) => {
      const next = { ...previous }
      if (value) next[name] = value
      else delete next[name]
      return next
    })
  }
  const save = async (reset = false) => {
    setBusy(true)
    setFailed(false)
    setSaved(false)
    try {
      const result = await api.save({ config: reset ? {} : config, confirmFullOverride: false })
      setConfig(result.config)
      setStored(JSON.stringify(result.config))
      setHadClosing(!!result.config.personaSuffix)
      setSaved(true)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <HomePageSection title={t('ctx.instructions')}>
        {replaced && <Banner tone="info">{t('ctx.replaced')}</Banner>}
        {!canSave && loaded && <SettingsState>{t('ctx.readOnly')}</SettingsState>}
        {busy && !loaded && <SettingsState tone="loading">{t('ctx.loading')}</SettingsState>}
        <SettingsCard data-testid="custom-instructions" aria-busy={busy}>
          <Field label={t('ctx.how')} htmlFor="custom-instructions-how">
            <SettingsTextArea
              id="custom-instructions-how"
              data-testid="system-prompt-personaPrefix"
              rows={5}
              maxLength={8192}
              placeholder={t('ctx.howPlaceholder')}
              value={config.personaPrefix ?? ''}
              disabled={locked}
              onChange={(event) => edit('personaPrefix', event.currentTarget.value)}
            />
          </Field>
          <Field label={t('ctx.style')} htmlFor="custom-instructions-style">
            <SettingsInput
              id="custom-instructions-style"
              data-testid="system-prompt-replyStyle"
              maxLength={8192}
              placeholder={t('ctx.stylePlaceholder')}
              value={config.replyStyle ?? ''}
              disabled={locked}
              onChange={(event) => edit('replyStyle', event.currentTarget.value)}
            />
          </Field>
          {hadClosing && (
            <Field label={t('ctx.closing')} htmlFor="custom-instructions-closing">
              <SettingsTextArea
                id="custom-instructions-closing"
                data-testid="system-prompt-personaSuffix"
                rows={3}
                maxLength={8192}
                value={config.personaSuffix ?? ''}
                disabled={locked}
                onChange={(event) => edit('personaSuffix', event.currentTarget.value)}
              />
            </Field>
          )}
          <SettingsToolbar className="capability-save">
            <Button
              appearance="ghost"
              data-testid="system-prompt-reset"
              disabled={locked || stored === '{}'}
              onClick={() => void save(true)}
            >
              {t('ctx.reset')}
            </Button>
            <Button
              appearance="primary"
              data-testid="system-prompt-save"
              disabled={locked || JSON.stringify(config) === stored}
              onClick={() => void save()}
            >
              {t('ctx.save')}
            </Button>
          </SettingsToolbar>
          {failed && (
            <SettingsState tone="error" role="alert">
              {t('ctx.failed')}
            </SettingsState>
          )}
          {saved && (
            <SettingsState tone="success" data-testid="system-prompt-saved">
              {t('ctx.saved')}
            </SettingsState>
          )}
        </SettingsCard>
      </HomePageSection>
      <HomePageSection title={t('ctx.auto')} actions={<small>{t('ctx.autoNote')}</small>}>
        <SettingsList>
          <ListRow
            icon={<IconTile name="file-text" />}
            title={t('ctx.rules')}
            description={t(context?.rulesEnabled === false ? 'ctx.rulesOff' : 'ctx.rulesHelp')}
            actions={<Provided on={context?.rulesEnabled !== false} t={t} />}
          />
          <ListRow
            icon={<IconTile name="clock" />}
            title={t('ctx.time')}
            description={
              context?.timeEnabled === false
                ? t('ctx.timeOff')
                : t('ctx.timeHelp', {
                    zone: context?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
                  })
            }
            actions={<Provided on={context?.timeEnabled !== false} t={t} />}
          />
        </SettingsList>
      </HomePageSection>
    </>
  )
}
