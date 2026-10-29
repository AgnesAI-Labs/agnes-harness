import type { McpServerDefinitionInput, McpServerDescriptor, SkillDescriptor } from '@agnes/protocol'
import type { JSX } from 'react'
import { useState } from 'react'
import { RESOURCE_DETAIL_LOCALE_NAMESPACE, resourceDetailLocaleCatalog } from './locales/resource-detail.js'
import { McpToolCatalog, type ToolCatalog } from './mcp-tool-catalog.js'
import { SettingsAdvanced, SettingsInput, SettingsSaveBar, SettingsState } from './settings-layout.js'
import { Button } from './ui/button.js'
import { Disclosure } from './ui/disclosure.js'
import { Field } from './ui/field.js'
import { IconButton } from './ui/icon-button.js'
import { Segmented } from './ui/segmented.js'
import { useUiText } from './ui-locale.js'

export type ResourceDetailAction = Readonly<{
  label: string
  className?: string
  disabled?: boolean
  title?: string
  /** Action summary: the shell consistently runs confirmation → submission → polling. */
  summary: string
  run(): Promise<{ operationId: string } | undefined>
}>

function FragmentedFact({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  )
}

function FactList({
  className,
  items,
}: {
  className: string
  items: readonly (readonly [string, string])[]
}): JSX.Element {
  return (
    <dl className={className}>
      {items.map(([label, value]) => (
        <FragmentedFact key={`${label}:${value}`} label={label} value={value} />
      ))}
    </dl>
  )
}

/** Progress row for an active operation, at the end of the scrollable detail area; cancellation uses the shell confirmation flow. */
export type ResourceProgress = Readonly<{
  text: string
  canCancel: boolean
  cancelTitle?: string | undefined
  onCancel(): void
}>

function DetailHead({
  kindLabel,
  title,
  subtitle,
  onClose,
}: {
  kindLabel: string
  title: string
  subtitle: string
  onClose(): void
}): JSX.Element {
  const { t } = useUiText(RESOURCE_DETAIL_LOCALE_NAMESPACE, resourceDetailLocaleCatalog)
  return (
    <div className="admin-detail-head">
      <p className="eyebrow">{kindLabel}</p>
      <div className="plugin-detail-heading">
        <h2>{title}</h2>
        <IconButton
          name="x"
          className="plugin-detail-close"
          label={t('close.aria', { title })}
          onClick={onClose}
        />
      </div>
      <p className="dialog-intro">{subtitle}</p>
    </div>
  )
}

/** Skill detail body. Override-priority editing and saving stay in this component; the shell validates and confirms the value. */
export function SkillDetailContent({
  skill,
  disabled,
  actions,
  progress,
  failure,
  onAction,
  onPrioritySave,
  onClose,
}: {
  skill: SkillDescriptor
  disabled: boolean
  actions: readonly ResourceDetailAction[]
  progress?: ResourceProgress | undefined
  /** The last action's refusal, shown here because the list's notice line is covered by this page. */
  failure?: string | undefined
  onAction(action: ResourceDetailAction): void
  onPrioritySave(next: number): void
  onClose(): void
}): JSX.Element {
  const { t } = useUiText(RESOURCE_DETAIL_LOCALE_NAMESPACE, resourceDetailLocaleCatalog)
  const [priority, setPriority] = useState(String(skill.priority))
  const priorityChanged = priority !== String(skill.priority)
  const priorityValid =
    Number.isInteger(Number(priority)) && Number(priority) >= 50 && Number(priority) <= 500
  const removing = skill.lastSafeError?.code === 'SKILL_REMOVAL_PENDING'
  return (
    <>
      <DetailHead
        kindLabel={t('skill.kind')}
        title={skill.name}
        subtitle={skill.description ?? t('skill.no-description')}
        onClose={onClose}
      />
      <div className="admin-detail-scroll">
        <FactList
          className="resource-facts"
          items={[
            [t('fact.source'), t(`skill.scope.${skill.sourceIdentity.scope}`)],
            [t('fact.catalog-state'), t(skill.stale ? 'fact.catalog-stale' : 'fact.catalog-current')],
          ]}
        />
        {skill.lastSafeError && (
          <SettingsState tone="error" className="resource-safe-error">
            {t('safe-error', {
              code: skill.lastSafeError.code,
              message: resourceFailureLabel(skill.lastSafeError.code, t),
            })}
          </SettingsState>
        )}
        {/* Which copy wins when two skills share a name, and the identifiers behind it. */}
        <SettingsAdvanced
          title={t('skill.advanced')}
          data-testid="skill-advanced"
          summary={t('skill.advancedSummary', {
            priority: skill.priority,
            state: t(skill.resolution.winner ? 'fact.current-winner' : 'fact.not-winner'),
            shadowed: skill.resolution.shadowed.length,
          })}
        >
          <FactList
            className="resource-facts"
            items={[
              [t('fact.source'), `${skill.sourceIdentity.scope} · ${skill.sourceIdentity.rootKey}`],
              [t('fact.resolution'), t(skill.resolution.winner ? 'fact.current-winner' : 'fact.not-winner')],
              [t('fact.version'), skill.revision],
            ]}
          />
          {skill.resolution.shadowed.length > 0 && (
            <Disclosure
              variant="plain"
              className="confirm-review-section"
              summary={t('shadowed', { count: skill.resolution.shadowed.length })}
            >
              <ul>
                {skill.resolution.shadowed.map((candidate) => (
                  <li
                    key={`${candidate.sourceIdentity.scope}:${candidate.sourceIdentity.rootKey}:${candidate.reason}`}
                  >
                    {`${candidate.sourceIdentity.scope} · ${candidate.sourceIdentity.rootKey} · ${candidate.reason}`}
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
          {skill.sourceIdentity.scope !== 'runtime' && !removing && (
            <Field
              label={t('priority.label')}
              error={priorityChanged && !priorityValid ? t('priority.invalid') : undefined}
            >
              <SettingsInput
                type="number"
                min={50}
                max={500}
                step={1}
                required
                value={priority}
                disabled={disabled}
                onChange={(event) => setPriority(event.currentTarget.value)}
              />
            </Field>
          )}
        </SettingsAdvanced>
        {skill.sourceIdentity.scope === 'runtime' && <p>{t('skill.plugin-managed')}</p>}
        {progress && (
          <div className="resource-operation">
            <span>{progress.text}</span>
            {progress.canCancel && (
              <Button htmlType="button" size="small" title={progress.cancelTitle} onClick={progress.onCancel}>
                {t('operation.cancel')}
              </Button>
            )}
          </div>
        )}
        {failure && (
          <p className="plugin-form-error" role="alert">
            {failure}
          </p>
        )}
      </div>
      <div className="admin-detail-actions">
        {actions.map((action) => (
          <Button
            key={action.label}
            htmlType="button"
            {...(action.className ? { className: action.className } : {})}
            danger={action.className?.includes('danger') ?? false}
            disabled={action.disabled ?? false}
            {...(action.title === undefined ? {} : { title: action.title, disabledReason: action.title })}
            onClick={() => onAction(action)}
          >
            {action.label}
          </Button>
        ))}
        {skill.sourceIdentity.scope !== 'runtime' && !removing && (
          <SettingsSaveBar
            dirty={priorityChanged}
            busy={disabled}
            onDiscard={() => setPriority(String(skill.priority))}
            onSave={() => {
              const next = Number(priority)
              if (!Number.isInteger(next) || next < 50 || next > 500) return
              onPrioritySave(next)
            }}
            saveLabel={t('priority.save')}
          />
        )}
      </div>
    </>
  )
}

type StatusPanel = readonly (readonly [string, string])[]

type McpToolDisclosure = NonNullable<McpServerDefinitionInput['toolDisclosure']>
const TOOL_DISCLOSURE_MODES: readonly McpToolDisclosure[] = ['auto', 'always', 'on-demand']

/** MCP detail body. This component manages async connection-status/tool-catalog panels; shell callbacks perform API calls. */
export function McpDetailContent({
  server,
  disabled,
  actions,
  progress,
  failure,
  onAction,
  onStatus,
  onTools,
  onEdit,
  onClose,
  onToolDisclosure,
}: {
  server: McpServerDescriptor
  disabled: boolean
  actions: readonly ResourceDetailAction[]
  progress?: ResourceProgress | undefined
  /** The last action's refusal, shown here because the list's notice line is covered by this page. */
  failure?: string | undefined
  onAction(action: ResourceDetailAction): void
  onStatus(): Promise<StatusPanel>
  onTools(cursor?: string): Promise<ToolCatalog>
  onEdit(): void
  onClose(): void
  /** Saves how this server's tools reach the model. Absent hides the control. */
  onToolDisclosure?(mode: McpToolDisclosure): void
}): JSX.Element {
  const { t } = useUiText(RESOURCE_DETAIL_LOCALE_NAMESPACE, resourceDetailLocaleCatalog)
  const disclosure = server.definition.toolDisclosure ?? 'auto'
  const [status, setStatus] = useState<StatusPanel | undefined>()
  const [catalog, setCatalog] = useState<ToolCatalog | undefined>()
  return (
    <>
      <DetailHead
        kindLabel={t('mcp.kind')}
        title={server.displayName}
        subtitle={`${server.serverId} · ${server.transportKind.toUpperCase()} · ${t('mcp.credentials', { kind: server.secretBindingKind })}`}
        onClose={onClose}
      />
      <div className="admin-detail-scroll">
        <FactList className="resource-facts" items={[[t('mcp.fact.source'), server.source]]} />
        {server.secretBindingKind === 'oauth' && (
          <div className="resource-oauth" data-testid="mcp-oauth" data-status={server.authorizationStatus}>
            <FactList
              className="resource-facts"
              items={[[t('mcp.oauth.label'), t(`mcp.oauth.${server.authorizationStatus ?? 'pending'}`)]]}
            />
            {/* Signing in is a top-level visit to the provider; this page stays open behind it. */}
            <Button
              size="small"
              appearance={server.authorizationStatus === 'authorized' ? 'secondary' : 'primary'}
              data-testid="mcp-oauth-authorize"
              href={`/oauth/${encodeURIComponent(server.serverId)}/start`}
              target="_blank"
              rel="noopener"
            >
              {t(server.authorizationStatus === 'authorized' ? 'mcp.oauth.again' : 'mcp.oauth.authorize')}
            </Button>
          </div>
        )}
        {server.lastSafeError && (
          <SettingsState tone="error" className="resource-safe-error">
            {t('safe-error', {
              code: server.lastSafeError.code,
              message: resourceFailureLabel(server.lastSafeError.code, t),
            })}
          </SettingsState>
        )}
        {!status && (
          <Button
            htmlType="button"
            size="small"
            disabled={disabled}
            onClick={() => void onStatus().then(setStatus)}
          >
            {t('mcp.status.show')}
          </Button>
        )}
        {status && <FactList className="resource-facts" items={status} />}
        {!catalog && (
          <Button
            htmlType="button"
            size="small"
            disabled={disabled}
            onClick={() => void onTools().then(setCatalog)}
          >
            {t('mcp.tools.show')}
          </Button>
        )}
        {catalog && (
          <Disclosure
            variant="plain"
            className="confirm-review-section"
            defaultOpen
            summary={t('mcp.tools.title', { count: catalog.items.length })}
          >
            <div>
              <McpToolCatalog items={catalog.items} />
              {catalog.nextCursor && (
                <Button
                  htmlType="button"
                  size="small"
                  disabled={disabled}
                  onClick={() =>
                    void onTools(catalog.nextCursor).then((next) =>
                      setCatalog({
                        items: [...catalog.items, ...next.items],
                        nextCursor: next.nextCursor,
                      }),
                    )
                  }
                >
                  {t('mcp.tools.more')}
                </Button>
              )}
            </div>
          </Disclosure>
        )}
        {onToolDisclosure && (
          <SettingsAdvanced
            title={t('mcp.disclosure.title')}
            summary={t(`mcp.disclosure.${disclosure}`)}
            data-testid="mcp-tool-disclosure"
          >
            <Field label={t('mcp.disclosure.label')} hint={t('mcp.disclosure.hint')}>
              <Segmented<McpToolDisclosure>
                label={t('mcp.disclosure.label')}
                value={disclosure}
                disabled={disabled}
                testId="mcp-tool-disclosure-mode"
                options={TOOL_DISCLOSURE_MODES.map((mode) => ({
                  value: mode,
                  label: t(`mcp.disclosure.${mode}`),
                  testId: `mcp-tool-disclosure-${mode}`,
                }))}
                onChange={(mode) => {
                  if (mode !== disclosure) onToolDisclosure(mode)
                }}
              />
            </Field>
          </SettingsAdvanced>
        )}
        {progress && (
          <div className="resource-operation">
            <span>{progress.text}</span>
            {progress.canCancel && (
              <Button htmlType="button" size="small" title={progress.cancelTitle} onClick={progress.onCancel}>
                {t('operation.cancel')}
              </Button>
            )}
          </div>
        )}
        {failure && (
          <p className="plugin-form-error" role="alert">
            {failure}
          </p>
        )}
      </div>
      <div className="admin-detail-actions">
        {actions.map((action) => (
          <Button
            key={action.label}
            htmlType="button"
            {...(action.className ? { className: action.className } : {})}
            danger={action.className?.includes('danger') ?? false}
            disabled={action.disabled ?? false}
            {...(action.title === undefined ? {} : { title: action.title, disabledReason: action.title })}
            onClick={() => onAction(action)}
          >
            {action.label}
          </Button>
        ))}
        <Button htmlType="button" className="secondary-button compact" disabled={disabled} onClick={onEdit}>
          {t('mcp.edit')}
        </Button>
      </div>
    </>
  )
}

export type { StatusPanel, ToolCatalog }

import { resourceFailureLabel } from './resource-failure.js'
