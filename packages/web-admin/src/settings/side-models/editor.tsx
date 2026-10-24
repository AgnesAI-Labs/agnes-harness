import {
  Button,
  Field,
  Icon,
  MetaText,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  useUiText,
} from '@agnes/web-ui'
import { type ReactNode, useState } from 'react'
import { SIDE_MODELS_NAMESPACE, sideModelsCatalog } from '../side-models-locale.js'
import { blankModel, draftProvider, type EditorDraft, type ModelDraft } from './model.js'

export type SideModelEditorProps = {
  draft: EditorDraft
  /** The route the entry is called by: derived from the name while new, fixed once saved. */
  route: string
  canSave: boolean
  busy: boolean
  fieldError: 'baseUrl' | 'credentialRef' | undefined
  endpointChanged: boolean
  options: readonly { id: string; label: string }[]
  testState: string
  /** The save outcome line. */
  status: ReactNode
  onPatch(next: Partial<EditorDraft>): void
  onModels(update: (models: ModelDraft[]) => ModelDraft[]): void
  /** Creates a credential and selects it; resolves whether it was created. */
  onCreateCredential(label: string, value: string): Promise<boolean>
  onProbe(): void
  onCancel(): void
  onSave(): void
}

const COSTS = [
  ['costInput', 'side.costInput', 'input'],
  ['costOutput', 'side.costOutput', 'output'],
  ['costCacheRead', 'side.costCacheRead', 'cache-read'],
  ['costCacheWrite', 'side.costCacheWrite', 'cache-write'],
] as const

/** Adding or editing one side model: Basic information, Connection and Model, then the optional test and save. */
export function SideModelEditor(props: SideModelEditorProps) {
  const { t } = useUiText(SIDE_MODELS_NAMESPACE, sideModelsCatalog)
  const { draft, busy, fieldError, endpointChanged } = props
  const [creating, setCreating] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newValue, setNewValue] = useState('')
  const patchModel = (index: number, next: Partial<ModelDraft>) =>
    props.onModels((models) => models.map((row, at) => (at === index ? { ...row, ...next } : row)))
  const createCredential = async () => {
    if (!(await props.onCreateCredential(newLabel.trim(), newValue.trim()))) return
    setNewLabel('')
    setNewValue('')
    setCreating(false)
  }
  return (
    <div className="side-editor" data-testid="side-editor">
      <SettingsSection title={t('side.basics')} description={t('side.basicsNote')}>
        <div className="side-editor-fields">
          <div className="side-editor-static">
            <span>{t('side.adapter')}</span>
            <span className="side-editor-chip" data-testid="side-adapter" data-value={draftProvider()}>
              {t(`side.adapter.${draftProvider()}`)}
              <MetaText>· {t('side.adapterOnly')}</MetaText>
            </span>
          </div>
          <Field
            label={t('side.label')}
            hint={
              <span className="side-editor-route" data-testid="side-route-preview">
                {t('side.routeName')} <code translate="no">{props.route}</code>
              </span>
            }
          >
            <SettingsInput
              data-testid="side-label"
              value={draft.label}
              disabled={busy}
              onChange={(event) => props.onPatch({ label: event.target.value })}
            />
          </Field>
        </div>
      </SettingsSection>
      <SettingsSection title={t('side.connection')} description={t('side.connectionNote')}>
        <div className="side-editor-fields">
          <Field
            label={t('side.baseUrl')}
            error={
              fieldError === 'baseUrl' ? (
                <span id="side-base-url-error">{t('side.invalidBaseUrl')}</span>
              ) : undefined
            }
          >
            <SettingsInput
              className="side-editor-mono"
              data-testid="side-base-url"
              value={draft.baseUrl}
              disabled={busy}
              onChange={(event) => props.onPatch({ baseUrl: event.target.value })}
            />
          </Field>
          <Field
            label={t('side.credential')}
            error={
              fieldError === 'credentialRef' ? (
                <span id="side-credential-hint">
                  {t(endpointChanged ? 'side.endpointChanged' : 'side.credentialChoose')}
                </span>
              ) : undefined
            }
            hint={
              endpointChanged ? (
                <span id="side-credential-hint">{t('side.endpointChanged')}</span>
              ) : (
                t('side.credentialHint')
              )
            }
          >
            <SettingsSelect
              data-testid="side-credential"
              value={draft.credentialRef}
              disabled={busy}
              onChange={(event) => props.onPatch({ credentialRef: event.target.value })}
            >
              <option value="">
                {t(draft.isNew || endpointChanged ? 'side.credentialChoose' : 'side.credentialKeep')}
              </option>
              {props.options.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </SettingsSelect>
          </Field>
          {creating ? (
            <div className="side-editor-new-credential">
              <Field label={t('side.credentialNewLabel')}>
                <SettingsInput
                  data-testid="side-credential-new-label"
                  value={newLabel}
                  disabled={busy}
                  onChange={(event) => setNewLabel(event.target.value)}
                />
              </Field>
              <Field label={t('side.credentialNewValue')}>
                <SettingsInput
                  data-testid="side-credential-new-value"
                  type="password"
                  value={newValue}
                  disabled={busy}
                  onChange={(event) => setNewValue(event.target.value)}
                />
              </Field>
              <Button
                data-testid="side-credential-create"
                disabled={busy || newLabel.trim() === '' || newValue.trim() === ''}
                onClick={() => void createCredential()}
              >
                {t('side.credentialCreate')}
              </Button>
            </div>
          ) : (
            <Button
              type="text"
              className="side-editor-link"
              data-testid="side-credential-new"
              disabled={busy}
              onClick={() => setCreating(true)}
            >
              <Icon name="plus" />
              {t('side.credentialNew')}
            </Button>
          )}
        </div>
      </SettingsSection>
      <SettingsSection
        title={t('side.models')}
        description={draft.isNew ? `${t('side.modelsNote')}${t('side.modelsPrefill')}` : t('side.modelsNote')}
      >
        <div className="side-editor-fields">
          {draft.models.map((row, index) => (
            <div key={row.key} className="side-editor-model" data-testid={`side-model-row-${index}`}>
              <div className="side-editor-grid">
                <Field label={t('side.modelId')}>
                  <SettingsInput
                    className="side-editor-mono"
                    data-testid={`side-model-id-${index}`}
                    value={row.id}
                    disabled={busy}
                    onChange={(event) => patchModel(index, { id: event.target.value })}
                  />
                </Field>
                <Field label={t('side.modelName')}>
                  <SettingsInput
                    data-testid={`side-model-name-${index}`}
                    value={row.name}
                    disabled={busy}
                    onChange={(event) => patchModel(index, { name: event.target.value })}
                  />
                </Field>
                <Field label={t('side.modelContext')}>
                  <SettingsInput
                    data-testid={`side-model-context-${index}`}
                    inputMode="numeric"
                    value={row.contextWindow}
                    disabled={busy}
                    onChange={(event) => patchModel(index, { contextWindow: event.target.value })}
                  />
                </Field>
                <Field label={t('side.modelTokens')}>
                  <SettingsInput
                    data-testid={`side-model-tokens-${index}`}
                    inputMode="numeric"
                    value={row.maxTokens}
                    disabled={busy}
                    onChange={(event) => patchModel(index, { maxTokens: event.target.value })}
                  />
                </Field>
              </div>
              <Button
                type="text"
                className="side-editor-fold"
                data-testid={`side-model-cost-toggle-${index}`}
                aria-expanded={row.showCost}
                disabled={busy}
                onClick={() => patchModel(index, { showCost: !row.showCost })}
              >
                <Icon name={row.showCost ? 'chevron-down' : 'chevron-right'} />
                {t('side.costToggle')}
              </Button>
              {row.showCost && (
                <div className="side-editor-grid">
                  {COSTS.map(([field, label, testid]) => (
                    <Field key={field} label={t(label)}>
                      <SettingsInput
                        data-testid={`side-model-cost-${testid}-${index}`}
                        inputMode="decimal"
                        value={row[field]}
                        disabled={busy}
                        onChange={(event) =>
                          patchModel(index, { [field]: event.target.value } as Partial<ModelDraft>)
                        }
                      />
                    </Field>
                  ))}
                </div>
              )}
              {draft.models.length > 1 && (
                <Button
                  type="text"
                  className="side-editor-link"
                  data-testid={`side-model-row-remove-${index}`}
                  disabled={busy}
                  onClick={() => props.onModels((models) => models.filter((_, at) => at !== index))}
                >
                  {t('side.modelRemove')}
                </Button>
              )}
            </div>
          ))}
          <Button
            type="text"
            className="side-editor-link"
            data-testid="side-model-row-add"
            disabled={busy}
            onClick={() => props.onModels((models) => [...models, blankModel()])}
          >
            <Icon name="plus" />
            {t('side.modelAdd')}
          </Button>
        </div>
      </SettingsSection>
      {props.status}
      <div className="side-editor-footer">
        <div className="side-editor-test">
          <Button data-testid="side-test" disabled={busy} onClick={props.onProbe}>
            {t('side.test')}
          </Button>
          {props.testState && (
            <span
              role={props.testState === 'side.testOk' ? 'status' : 'alert'}
              data-tone={props.testState === 'side.testOk' ? 'success' : 'error'}
              data-testid="side-test-status"
            >
              {props.testState === 'side.testOk' && <Icon name="check" />}
              {t(props.testState)}
            </span>
          )}
          <MetaText data-testid="side-test-note">{t('side.testNote')}</MetaText>
        </div>
        <div className="agnes-settings-actions">
          <Button data-testid="side-cancel" disabled={busy} onClick={props.onCancel}>
            {t('side.cancel')}
          </Button>
          <Button
            appearance="primary"
            data-testid="side-save"
            disabled={!props.canSave || busy}
            onClick={props.onSave}
          >
            {t('side.save')}
          </Button>
        </div>
      </div>
    </div>
  )
}
