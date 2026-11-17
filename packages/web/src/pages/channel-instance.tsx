import { CredentialCreate, useCredentialWrite } from '@agnes/resource-control-web/credential-create'
import { Field, Select, SettingsCheckbox, SettingsDetails, SettingsInput } from '@agnes/web-ui'
import { useId, useState } from 'react'
import { ChannelOptions } from './channel-options.js'
import type { Instance, Provider } from './channel-types.js'

export function InstanceForm({
  value,
  provider,
  credentials,
  disabled,
  zh,
  onChange,
}: {
  value: Instance
  provider: Provider
  credentials: { id: string; label: string }[]
  disabled: boolean
  zh: boolean
  onChange(value: Instance): void
}) {
  const prefix = useId()
  const [allowFromText, setAllowFromText] = useState(value.allowFrom.join(','))
  const write = useCredentialWrite()
  // Metadata of credentials created here, shown until the shared list catches up.
  const [created, setCreated] = useState<{ id: string; label: string }[]>([])
  const choices = [...credentials, ...created.filter((item) => !credentials.some((c) => c.id === item.id))]
  const select = (key: string, ref: string | undefined) => {
    const refs = { ...value.credentialRefs }
    if (ref) refs[key] = ref
    else delete refs[key]
    onChange({ ...value, credentialRefs: refs })
  }
  const credential = (key: string, optional = false) => (
    <div key={key} className="channel-credential-field">
      <Field label={key + (optional ? '' : ' *')} optional={optional} htmlFor={`${prefix}-credential-${key}`}>
        <Select
          id={`${prefix}-credential-${key}`}
          aria-label={key}
          disabled={disabled}
          allowClear
          placeholder={zh ? '选择已保存的凭据' : 'Choose a saved credential'}
          value={value.credentialRefs[key] ?? null}
          options={choices.map((item) => ({ value: item.id, label: item.label }))}
          notFoundContent={zh ? '暂无凭据，可点击“新建凭据”' : 'No credentials yet. Use New credential.'}
          onChange={(ref: string | undefined) => select(key, ref)}
        />
      </Field>
      <CredentialCreate
        testId="channel-credential-create"
        write={write}
        disabled={disabled}
        onCreated={(item) => {
          setCreated((previous) => [...previous, { id: item.id, label: item.label }])
          select(key, item.id)
        }}
      />
    </div>
  )
  return (
    <fieldset disabled={disabled} className="channel-instance channel-credential-form">
      <legend className="visually-hidden">{value.id || (zh ? '新实例' : 'New instance')}</legend>
      <div className="channel-form-section">
        <h5>{zh ? '连接凭据' : 'Connection credentials'}</h5>
        <p>
          {zh
            ? '选择已保存的凭据，或在字段旁新建；密钥只写入、不会显示在此页面。'
            : 'Choose a saved credential or create one beside the field. Secret values are write-only.'}
        </p>
        <div className="channel-field-grid">
          {provider.manifest.credentials.required.map((key) => credential(key))}
        </div>
      </div>
      <ChannelOptions
        provider={provider}
        value={value.config ?? {}}
        disabled={disabled}
        onChange={(config) => onChange({ ...value, config })}
      />
      <SettingsDetails title={zh ? '高级设置' : 'Advanced settings'} compact>
        <div className="channel-advanced">
          {!!provider.manifest.credentials.optional.length && (
            <div className="channel-field-grid">
              {provider.manifest.credentials.optional.map((key) => credential(key, true))}
            </div>
          )}
          <Field
            label={zh ? '允许的用户 ID' : 'Allowed user IDs'}
            htmlFor={`${prefix}-allowFrom`}
            hint={
              zh
                ? '多个 ID 用逗号分隔，留空允许所有用户。'
                : 'Separate IDs with commas. Leave empty to allow all users.'
            }
          >
            <SettingsInput
              id={`${prefix}-allowFrom`}
              disabled={disabled}
              value={allowFromText}
              onChange={(event) => {
                setAllowFromText(event.target.value)
                onChange({
                  ...value,
                  allowFrom: event.target.value
                    .split(/[,，\n]/)
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }}
            />
          </Field>
          <SettingsCheckbox
            disabled={disabled}
            label={zh ? '群聊需要 @机器人' : 'Require a bot mention in groups'}
            checked={value.requireMention}
            onChange={(event) => onChange({ ...value, requireMention: event.target.checked })}
          />
        </div>
      </SettingsDetails>
    </fieldset>
  )
}
