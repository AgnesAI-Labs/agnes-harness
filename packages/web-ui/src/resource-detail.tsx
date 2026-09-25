import type { McpServerDescriptor, SkillDescriptor } from '@agnes/protocol'
import type { JSX } from 'react'
import { useState } from 'react'

export type ResourceDetailAction = Readonly<{
  label: string
  className?: string
  disabled?: boolean
  title?: string
  /** 动作摘要：由壳统一走确认框 → 提交 → 轮询的链路。 */
  summary: string
  run(): Promise<{ operationId: string }>
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
  return (
    <div className="admin-detail-head">
      <p className="eyebrow">{kindLabel}</p>
      <div className="plugin-detail-heading">
        <h2>{title}</h2>
        <button
          type="button"
          className="secondary-button compact plugin-detail-close"
          aria-label={`关闭 ${title} 的详情`}
          onClick={onClose}
        >
          关闭详情
        </button>
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
  const [priority, setPriority] = useState(String(skill.priority))
  const removing = skill.lastSafeError?.code === 'SKILL_REMOVAL_PENDING'
  return (
    <>
      <DetailHead
        kindLabel="Skill 资源"
        title={skill.name}
        subtitle={skill.description ?? '该 Skill 未提供说明。'}
        onClose={onClose}
      />
      <div className="admin-detail-scroll">
        <FactList
          className="resource-facts"
          items={[
            ['来源', `${skill.sourceIdentity.scope} · ${skill.sourceIdentity.rootKey}`],
            ['优先级', String(skill.priority)],
            ['解析', skill.resolution.winner ? '当前 winner' : '非 winner'],
            ['信任', skill.trust === 'trusted' ? '已信任' : skill.trust === 'rejected' ? '已拒绝' : '未信任'],
            ['期望状态', skill.desired === 'enabled' ? '已启用' : '已停用'],
            ['实际状态', skill.actual],
            ['版本', skill.revision],
            ['目录状态', skill.stale ? '使用最近一次安全目录（刷新失败）' : '最新目录'],
          ]}
        />
        {skill.resolution.shadowed.length > 0 && (
          <details className="confirm-review-section">
            <summary>{`被遮蔽的候选（${skill.resolution.shadowed.length}）`}</summary>
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
          <p className="resource-safe-error">
            {`${skill.lastSafeError.code}：${skill.lastSafeError.message}`}
          </p>
        )}
        {skill.sourceIdentity.scope !== 'runtime' && !removing && (
          <label>
            同名覆盖优先级（50–500，越大越优先）
            <input
              type="number"
              min={50}
              max={500}
              step={1}
              required
              value={priority}
              disabled={disabled}
              onChange={(event) => setPriority(event.currentTarget.value)}
            />
          </label>
        )}
        {skill.sourceIdentity.scope === 'runtime' && (
          <p>此 Skill 由插件提供，请通过插件管理移除，不能单独删除文件。</p>
        )}
        {progress && (
          <div className="resource-operation">
            <span>{progress.text}</span>
            {progress.canCancel && (
              <button
                type="button"
                className="secondary-button compact"
                title={progress.cancelTitle}
                onClick={progress.onCancel}
              >
                取消操作
              </button>
            )}
          </div>
        )}
      </div>
      <div className="admin-detail-actions">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className={action.className ?? 'secondary-button compact'}
            disabled={action.disabled}
            title={action.title}
            onClick={() => onAction(action)}
          >
            {action.label}
          </button>
        ))}
        {skill.sourceIdentity.scope !== 'runtime' && !removing && (
          <button
            type="button"
            className="secondary-button compact"
            disabled={disabled}
            onClick={() => {
              const next = Number.parseInt(priority, 10)
              if (!Number.isInteger(next) || next < 50 || next > 500) return
              onPrioritySave(next)
            }}
          >
            保存优先级
          </button>
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
  const [status, setStatus] = useState<StatusPanel | undefined>()
  const [catalog, setCatalog] = useState<ToolCatalog | undefined>()
  return (
    <>
      <DetailHead
        kindLabel="MCP 服务"
        title={server.displayName}
        subtitle={`${server.serverId} · ${server.transportKind.toUpperCase()} · 凭据：${server.secretBindingKind}`}
        onClose={onClose}
      />
      <div className="admin-detail-scroll">
        <FactList
          className="resource-facts"
          items={[
            [
              '信任',
              server.trust === 'trusted' ? '已信任' : server.trust === 'rejected' ? '已拒绝' : '未信任',
            ],
            ['期望状态', server.desired === 'enabled' ? '已启用' : '已停用'],
            ['实际状态', server.actual],
            ['来源', server.source],
          ]}
        />
        {server.lastSafeError && (
          <p className="resource-safe-error">
            {`${server.lastSafeError.code}：${server.lastSafeError.message}`}
          </p>
        )}
        {!status && (
          <button
            type="button"
            className="secondary-button compact"
            disabled={disabled}
            onClick={() => void onStatus().then(setStatus)}
          >
            查看连接状态
          </button>
        )}
        {status && <FactList className="resource-facts" items={status} />}
        {!catalog && (
          <button
            type="button"
            className="secondary-button compact"
            disabled={disabled}
            onClick={() => void onTools().then(setCatalog)}
          >
            查看工具目录
          </button>
        )}
        {catalog && (
          <details className="confirm-review-section" open>
            <summary>{`工具目录（${catalog.names.length}）`}</summary>
            <div>
              {catalog.names.map((name) => (
                <p key={name}>{name}</p>
              ))}
              {catalog.nextCursor && (
                <button
                  type="button"
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
                  加载更多工具
                </button>
              )}
            </div>
          </details>
        )}
        {progress && (
          <div className="resource-operation">
            <span>{progress.text}</span>
            {progress.canCancel && (
              <button
                type="button"
                className="secondary-button compact"
                title={progress.cancelTitle}
                onClick={progress.onCancel}
              >
                取消操作
              </button>
            )}
          </div>
        )}
      </div>
      <div className="admin-detail-actions">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className={action.className ?? 'secondary-button compact'}
            disabled={action.disabled}
            title={action.title}
            onClick={() => onAction(action)}
          >
            {action.label}
          </button>
        ))}
        <button type="button" className="secondary-button compact" disabled={disabled} onClick={onEdit}>
          编辑
        </button>
      </div>
    </>
  )
}

export type { StatusPanel, ToolCatalog }
