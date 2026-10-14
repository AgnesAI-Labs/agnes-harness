import { sessionStartUrl } from '@agnes/web-admin/settings/runtime-panels'
import { Button, Dialog, Field, SettingsInput } from '@agnes/web-ui'
import { useState } from 'react'

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string

/** The address of a new session with the skill invocation typed in, ready to send. */
export function skillRunUrl(name: string, args: string): string {
  return sessionStartUrl(undefined, `/skill invoke ${name} ${args}`.trim())
}

/**
 * 「在新会话中运行」 from a skill row: optional arguments, then a new session opens with the
 * invocation filled in. Nothing runs until the person sends it there.
 */
export function SkillRunDialog({ name, t, onClose }: { name: string | undefined; t: Text; onClose(): void }) {
  const [args, setArgs] = useState('')
  const open = () => {
    if (name) location.assign(skillRunUrl(name, args))
  }
  return (
    <Dialog
      open={!!name}
      size="sm"
      title={name ? t('skill.run.title', { name }) : ''}
      onCancel={() => {
        setArgs('')
        onClose()
      }}
      footer={
        <Button appearance="primary" data-testid="skill-run-open" onClick={open}>
          {t('skill.run.open')}
        </Button>
      }
    >
      <p className="agnes-settings-note">{t('skill.run.help')}</p>
      <Field htmlFor="skill-run-args" label={t('skill.run.args')}>
        <SettingsInput
          id="skill-run-args"
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
      </Field>
    </Dialog>
  )
}
