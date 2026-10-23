import { sessionStartUrl } from '@agnes/web-admin/settings/runtime-panels'
import { Button, PushPage, SettingsGroup, SettingsInput, SettingsItem, SettingsToolbar } from '@agnes/web-ui'
import { useState } from 'react'
import { pluginPageId } from './route.js'

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string

/** The address of a new session with the skill invocation typed in, ready to send. */
export function skillRunUrl(name: string, args: string): string {
  return sessionStartUrl(undefined, `/skill invoke ${name} ${args}`.trim())
}

/**
 * 「Run in new session」 from a skill row, as a page over the skills list: optional arguments, then a new
 * session opens with the invocation filled in. Nothing runs until the person sends it there.
 */
export function SkillRunPage({ name, t }: { name: string; t: Text }) {
  const [args, setArgs] = useState('')
  const open = () => location.assign(skillRunUrl(name, args))
  return (
    <PushPage
      id={pluginPageId({ kind: 'run', id: name })}
      title={t('skill.run.title', { name })}
      description={t('skill.run.help')}
    >
      <SettingsGroup>
        <SettingsItem stacked label={t('skill.run.args')} labelId="skill-run-args-label">
          <SettingsInput
            id="skill-run-args"
            aria-labelledby="skill-run-args-label"
            data-testid="skill-run-args"
            value={args}
            onChange={(event) => setArgs(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                open()
              }
            }}
          />
        </SettingsItem>
      </SettingsGroup>
      <SettingsToolbar className="capability-save">
        <Button appearance="primary" data-testid="skill-run-open" onClick={open}>
          {t('skill.run.open')}
        </Button>
      </SettingsToolbar>
    </PushPage>
  )
}
