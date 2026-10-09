import { SettingsInput, SettingsState } from './settings-layout.js'
import { Field } from './ui/field.js'
import { Button } from './ui/button.js'
import type { McpServerDescriptor, SkillDescriptor } from '@agnes/protocol'
import type { JSX } from 'react'
import { useState } from 'react'
import { RESOURCE_DETAIL_LOCALE_NAMESPACE, resourceDetailLocaleCatalog } from './locales/resource-detail.js'
import { useUiText } from './ui-locale.js'

export type ResourceDetailAction = Readonly<{
  label: string
  className?: string
  disabled?: boolean
  title?: string
  /** 动作摘要：由壳统一走确认框 → 提交 → 轮询的链路。 */
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

/** 进行中操作的进度行：渲染在详情滚动区末尾，取消走壳的确认链。 */
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
        <Button
          htmlType="button"
          className="secondary-button compact plugin-detail-close"
          aria-label={t('close.aria', { title })}
          onClick={onClose}
        >
          {t('close')}
        </Button>
      </div>
      <p className="dialog-intro">{subtitle}</p>
    </div>
  )
}

/** Skill 详情体。同名覆盖优先级的输入与保存在此组件内闭环，数值交给壳校验与确认。 */
export function SkillDetailContent({
  skill,
  disabled,
  actions,
  progress,
  onAction,
  onPrioritySave,
  onClose,
}: {
  skill: SkillDescriptor
  disabled: boolean
  actions: readonly ResourceDetailAction[]
  progress?: ResourceProgress | undefined
  onAction(action: ResourceDetailAction): void
  onPrioritySave(next: number): void
  onClose(): void
}): JSX.Element {
  const { t } = useUiText(RESOURCE_DETAIL_LOCALE_NAMESPACE, resourceDetailLocaleCatalog)
  const [priority, setPriority] = useState(String(skill.priority))
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
            [t('fact.source'), `${skill.sourceIdentity.scope} · ${skill.sourceIdentity.rootKey}`],
            [t('fact.priority'), String(skill.priority)],
            [t('fact.resolution'), t(skill.resolution.winner ? 'fact.current-winner' : 'fact.not-winner')],
            [t('fact.version'), skill.revision],
            [t('fact.catalog-state'), t(skill.stale ? 'fact.catalog-stale' : 'fact.catalog-current')],
          ]}
        />
        {skill.resolution.shadowed.length > 0 && (
          <details className="confirm-review-section">
            <summary>{t('shadowed', { count: skill.resolution.shadowed.length })}</summary>
            <ul>
              {skill.resolution.shadowed.map((candidate) => (
                <li
                  key={`${candidate.sourceIdentity.scope}:${candidate.sourceIdentity.rootKey}:${candidate.reason}`}
                >
                  {`${candidate.sourceIdentity.scope} · ${candidate.sourceIdentity.rootKey} · ${candidate.reason}`}
                </li>
              ))}
            </ul>
          </details>
        )}
        {skill.lastSafeError && (
          <SettingsState tone="error" className="resource-safe-error">
            {t('safe-error', {
              code: skill.lastSafeError.code,
              message: resourceFailureLabel(skill.lastSafeError.code, t),
            })}
          </SettingsState>
        )}
        {skill.sourceIdentity.scope !== 'runtime' && !removing && (
          <Field label={t('priority.label')}>
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
        {skill.sourceIdentity.scope === 'runtime' && <p>{t('skill.plugin-managed')}</p>}
        {progress && (
          <div className="resource-operation">
            <span>{progress.text}</span>
            {progress.canCancel && (
              <Button
                htmlType="button"
                className="secondary-button compact"
                title={progress.cancelTitle}
                onClick={progress.onCancel}
              >
                {t('operation.cancel')}
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="admin-detail-actions">
        {actions.map((action) => (
          <Button
            key={action.label}
            htmlType="button"
            className={action.className ?? 'secondary-button compact'}
            danger={action.className?.includes('danger-button')}
            disabled={action.disabled}
            title={action.title}
            onClick={() => onAction(action)}
          >
            {action.label}
          </Button>
        ))}
        {skill.sourceIdentity.scope !== 'runtime' && !removing && (
          <Button
            htmlType="button"
            className="secondary-button compact"
            disabled={disabled}
            onClick={() => {
              const next = Number.parseInt(priority, 10)
              if (!Number.isInteger(next) || next < 50 || next > 500) return
              onPrioritySave(next)
            }}
          >
            {t('priority.save')}
          </Button>
        )}
      </div>
    </>
  )
}

type StatusPanel = readonly (readonly [string, string])[]

type ToolCatalog = { names: readonly string[]; nextCursor: string | undefined }

/** MCP 详情体。「查看连接状态/工具目录」的异步面板在此组件内管理，api 调用由壳回调。 */
export function McpDetailContent({
  server,
  disabled,
  actions,
  progress,
  onAction,
  onStatus,
  onTools,
  onEdit,
  onClose,
}: {
  server: McpServerDescriptor
  disabled: boolean
  actions: readonly ResourceDetailAction[]
  progress?: ResourceProgress | undefined
  onAction(action: ResourceDetailAction): void
  onStatus(): Promise<StatusPanel>
  onTools(cursor?: string): Promise<ToolCatalog>
  onEdit(): void
  onClose(): void
}): JSX.Element {
  const { t } = useUiText(RESOURCE_DETAIL_LOCALE_NAMESPACE, resourceDetailLocaleCatalog)
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
            className="secondary-button compact"
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
            className="secondary-button compact"
            disabled={disabled}
            onClick={() => void onTools().then(setCatalog)}
          >
            {t('mcp.tools.show')}
          </Button>
        )}
        {catalog && (
          <details className="confirm-review-section" open>
            <summary>{t('mcp.tools.title', { count: catalog.names.length })}</summary>
            <div>
              {catalog.names.map((name) => (
                <p key={name}>{name}</p>
              ))}
              {catalog.nextCursor && (
                <Button
                  htmlType="button"
                  className="secondary-button compact"
                  disabled={disabled}
                  onClick={() =>
                    void onTools(catalog.nextCursor).then((next) =>
                      setCatalog({
                        names: [...catalog.names, ...next.names],
                        nextCursor: next.nextCursor,
                      }),
                    )
                  }
                >
                  {t('mcp.tools.more')}
                </Button>
              )}
            </div>
          </details>
        )}
        {progress && (
          <div className="resource-operation">
            <span>{progress.text}</span>
            {progress.canCancel && (
              <Button
                htmlType="button"
                className="secondary-button compact"
                title={progress.cancelTitle}
                onClick={progress.onCancel}
              >
                {t('operation.cancel')}
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="admin-detail-actions">
        {actions.map((action) => (
          <Button
            key={action.label}
            htmlType="button"
            className={action.className ?? 'secondary-button compact'}
            danger={action.className?.includes('danger-button')}
            disabled={action.disabled}
            title={action.title}
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
