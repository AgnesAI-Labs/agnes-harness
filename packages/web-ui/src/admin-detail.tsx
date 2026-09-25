import type { PackageOperation } from '@agnes/protocol'
import type { JSX } from 'react'
import { operationLabel } from './admin-text.js'

export type DetailActionSpec = Readonly<{
  label: string
  className: string
  disabled?: boolean
  title?: string
  ariaLabel?: string
  /** 链接型动作渲染为 `<a target="_blank" rel="noopener">`，保留既有 `.plugin-surface-link` 契约。 */
  href?: string
  onClick(): void
}>

export type DetailOperationRow = Readonly<{
  operation: PackageOperation
  canCancel: boolean
}>

function BlockersSection({
  title,
  items,
}: {
  title: string
  items: readonly string[]
}): JSX.Element | undefined {
  if (!items.length) return undefined
  return (
    <section className="plugin-blockers">
      <h3>{title}</h3>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  )
}

/**
 * 详情/操作模态的内容体。`<dialog>` 元素留在宿主骨架里（showModal、Escape、焦点归还
 * 由壳管理）；React 只替换 dialog 的子节点，所以这里没有 dialog 元素本身。
 */
export function DetailContent({
  heading,
  intro,
  version,
  stateText,
  facts,
  blockerSections,
  operations,
  lastOperationLabel,
  actions,
  onClose,
  onCancelOperation,
}: {
  heading: string
  intro: string
  version: string | undefined
  stateText: string | undefined
  facts: readonly (readonly [label: string, value: string])[]
  blockerSections: readonly { title: string; items: readonly string[] }[]
  operations: readonly DetailOperationRow[]
  lastOperationLabel: string | undefined
  actions: readonly DetailActionSpec[]
  onClose(): void
  onCancelOperation(operationId: string, trigger: HTMLButtonElement): void
}): JSX.Element {
  return (
    <>
      <div className="admin-detail-head">
        <div className="plugin-detail-heading">
          <h2>{heading}</h2>
          <button
            type="button"
            className="secondary-button compact plugin-detail-close"
            onClick={onClose}
            aria-label={`关闭 ${heading} 的详情`}
          >
            关闭详情
          </button>
        </div>
        {version && <p className="plugin-detail-version">{version}</p>}
        {stateText && <p className="plugin-detail-state">{stateText}</p>}
        <p>{intro}</p>
      </div>
      <div className="admin-detail-scroll">
        {facts.length > 0 && (
          <dl className="plugin-facts">
            {facts.map(([label, value]) => (
              <FragmentedFact key={`${label}:${value}`} label={label} value={value} />
            ))}
          </dl>
        )}
        {blockerSections.map((section) => (
          <BlockersSection key={section.title} title={section.title} items={section.items} />
        ))}
        {lastOperationLabel && (
          <section className="plugin-operations">
            <h3>最近完成的操作</h3>
            <p>{lastOperationLabel}</p>
          </section>
        )}
        {operations.length > 0 && (
          <section className="plugin-operations">
            <h3>正在进行的操作</h3>
            {operations.map(({ operation, canCancel }) => (
              <div key={operation.operationId} className="operation-row">
                <p>
                  {operationLabel(operation)}
                  {operation.progress ? ` · ${operation.progress}%` : ''}
                  {operation.retryable ? ' · 后台允许重试' : ''}
                </p>
                {canCancel && (
                  <button
                    type="button"
                    className="secondary-button compact"
                    onClick={(event) => onCancelOperation(operation.operationId, event.currentTarget)}
                  >
                    请求取消
                  </button>
                )}
              </div>
            ))}
          </section>
        )}
      </div>
      <div className="admin-detail-actions">
        {actions.map((action) =>
          action.href ? (
            <a
              key={action.label}
              className={action.className}
              href={action.href}
              target="_blank"
              rel="noopener"
              aria-label={action.ariaLabel}
              onClick={action.onClick}
            >
              {action.label}
            </a>
          ) : (
            <button
              key={action.label}
              type="button"
              className={action.className}
              disabled={action.disabled}
              title={action.title}
              aria-label={action.ariaLabel}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ),
        )}
      </div>
    </>
  )
}

function FragmentedFact({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  )
}
