import type { ApplicationPreview, PresentationRole } from '@agnes/protocol'
import { resolveApplicationBrand } from '@agnes/web-client'
import {
  Disclosure,
  SettingsCode,
  SettingsGroup,
  SettingsItem,
  SettingsSection,
  SettingsTechnicalDetails,
  useDocumentLanguage,
} from '@agnes/web-ui'
import { type ReactNode, useEffect, useState } from 'react'

export const PRESENTATION_ROLE_LABELS = {
  navigation: ['Navigation', '导航'],
  conversation: ['Conversation', '对话'],
  composer: ['Composer', '输入框'],
  goal: ['Goal', '目标'],
  interaction: ['Interaction', '交互'],
  deliverables: ['Deliverables', '交付物'],
} satisfies Record<PresentationRole, [string, string]>

type Text = (en: string, zh: string) => string
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

function PreviewMark({ preview }: { preview: ApplicationPreview }) {
  const [mark, setMark] = useState<string>()
  useEffect(() => {
    const match = /^data:(image\/(?:png|jpeg|webp|gif|x-icon));base64,([A-Za-z0-9+/=]+)$/.exec(
      preview.assets.mark ?? '',
    )
    if (!match?.[1] || !match[2]) {
      setMark(undefined)
      return
    }
    const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: match[1] }))
    setMark(url)
    return () => URL.revokeObjectURL(url)
  }, [preview.assets.mark])
  return mark ? (
    <img
      className="application-review-mark"
      src={mark}
      alt=""
      width={40}
      height={40}
      onError={() => setMark(undefined)}
    />
  ) : (
    <span className="agnes-mark application-review-mark" aria-hidden="true" />
  )
}

const permissionLabels: Record<string, [string, string]> = {
  network: ['Network hosts', '网络主机'],
  exec: ['Run commands', '执行命令'],
  secrets: ['Secrets', '密钥'],
  credentials: ['Credentials', '凭据'],
  filesystem: ['Files', '文件'],
  read: ['Read files', '读取文件'],
  write: ['Write files', '写入文件'],
  model: ['Model access', '模型访问'],
  device: ['Use devices', '使用设备'],
  wake: ['Run in background', '后台运行'],
  uiData: ['Interface data', '界面数据'],
  streams: ['Live updates', '实时更新'],
  managedServices: ['Managed services', '托管服务'],
  childAgents: ['Child agents', '子代理'],
  ui: ['UI', '界面'],
  tools: ['Tools', '工具'],
  names: ['Names', '名称'],
  prefix: ['Prefix', '前缀'],
  store: ['Application records', '应用记录'],
  'tools.invoke': ['Use tools', '使用工具'],
}
type PermissionRow = { label: string; detail: string }
function permissionRows(value: unknown, tr: Text, path = ''): PermissionRow[] {
  if (path === tr('Tools', '工具'))
    return [{ label: tr('Use declared business tools', '使用已声明的业务工具'), detail: '' }]
  if (Array.isArray(value))
    return [
      { label: path, detail: value.length ? value.map(String).join(', ') : tr('None declared', '未声明') },
    ]
  const fields = object(value)
  if (fields)
    return Object.entries(fields).flatMap(([key, value]) =>
      permissionRows(
        value,
        tr,
        [path, tr(...(permissionLabels[key] ?? [key, key]))].filter(Boolean).join(' · '),
      ),
    )
  return [
    {
      label: path,
      detail:
        typeof value === 'boolean'
          ? value
            ? tr('Allowed', '允许')
            : tr('Not requested', '未请求')
          : String(value),
    },
  ]
}
const partLabels: Record<string, [string, string]> = {
  'primary-navigation': ['Primary navigation', '主导航'],
  'conversation-transcript': ['Conversation transcript', '对话正文'],
  'message-composer': ['Message composer', '消息输入区'],
  'goal-summary': ['Goal summary', '目标摘要'],
  'goal-workbench': ['Goal workbench', '目标工作区'],
  'interaction-cards': ['Interaction cards', '交互卡片'],
  'interaction-workbench': ['Interaction workbench', '交互工作区'],
  'deliverable-cards': ['Deliverable cards', '交付物卡片'],
  'deliverables-workbench': ['Deliverables workbench', '交付物工作区'],
}

export const navigationLabels: Record<string, [string, string]> = {
  agents: ['Agents', '智能体'],
  'business-agents': ['Agents', '智能体'],
  automation: ['Automation', '自动化'],
  schedules: ['Schedules', '定时任务'],
  triggers: ['Triggers', '触发器'],
  plugins: ['Plugins', '插件'],
}

/** One key-value row in the review: the name on the left, its value on the right. */
function ReviewRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <SettingsItem className="application-review-row" label={label}>
      <span className="application-review-value">{value}</span>
    </SettingsItem>
  )
}

/** A projection of the reviewed payload only; the original digest and write contract stay intact. */
export function ApplicationPreviewSummary({
  preview,
  application = false,
  description,
}: {
  preview: ApplicationPreview
  application?: boolean
  description?: string | undefined
}) {
  const language = useDocumentLanguage()
  const tr: Text = (en, zh) => (language === 'zh-CN' ? zh : en)
  const { declaration } = preview
  const navigation = declaration.presentation?.navigation
  const none = tr('None', '无')
  const host = tr('Official home page', '官方首页')
  const role = (name: string) => tr(...(PRESENTATION_ROLE_LABELS[name as PresentationRole] ?? [name, name]))
  const list = (values: readonly string[] | undefined, fallback = none) => values?.join(', ') || fallback
  const diff = object(preview.dependencyDiff)
  const raw = JSON.stringify(preview, null, 2)
  const localized = (value: unknown, fallback: string) => {
    const row = object(value)
    return text(row?.[language]) || text(row?.en) || fallback
  }
  const launches = preview.agentLaunches?.map(object) ?? []
  const agentName = (ref: string) =>
    localized(
      object(launches.find((plan) => plan?.ref === ref)?.launch)?.title,
      tr('Application agent', '应用智能体'),
    )
  const pageName = (ref: string) => {
    const page = preview.pageNames?.map(object).find((page) => page?.ref === ref)
    return localized(page?.title, tr('Application page', '应用页面'))
  }
  const brand = resolveApplicationBrand(declaration, language)
  const agents = declaration.agents ?? launches.map((plan) => text(plan?.ref))
  const agentRows = (
    <SettingsGroup>
      {agents.map((ref) => (
        <SettingsItem
          key={ref}
          icon="bot"
          label={agentName(ref)}
          description={localized(object(launches.find((plan) => plan?.ref === ref)?.launch)?.description, '')}
        >
          {ref === declaration.defaultAgent ? tr('Default', '默认') : undefined}
        </SettingsItem>
      ))}
    </SettingsGroup>
  )
  // Group identical human summaries; each agent’s exact tool and policy scopes remain in technical details.
  const access = new Map<string, { names: string[]; readOnly: boolean | undefined }>()
  for (const plan of launches) {
    const permission = object(plan?.permission)
    const readOnly = permission ? permission.readOnly === true : undefined
    const key = String(readOnly)
    const group = access.get(key) ?? { names: [], readOnly }
    group.names.push(agentName(text(plan?.ref)))
    access.set(key, group)
  }
  const permissions = [
    ...new Map(
      preview.dependencies.flatMap((value) => {
        const capabilities = object(object(value)?.capabilities)
        const rows = capabilities
          ? permissionRows(capabilities, tr)
          : [
              {
                label: tr('Permission declaration unavailable', '权限声明不可用'),
                detail: tr('Review technical details.', '请查看技术详情。'),
              },
            ]
        return rows.map((row) => [JSON.stringify(row), row] as const)
      }),
    ).values(),
  ]
  return (
    <div className="application-review">
      <div className="agnes-settings-stack" data-testid="consent-summary">
        {application && (
          <SettingsGroup>
            <SettingsItem
              className="application-review-brand"
              leading={<PreviewMark preview={preview} />}
              label={
                <>
                  {declaration.brand?.title ? brand.title : brand.name}
                  <span className="application-version">{preview.version}</span>
                </>
              }
              description={
                description ||
                localized(
                  object(launches.find((plan) => plan?.ref === declaration.defaultAgent)?.launch)
                    ?.description,
                  tr('Application home page, navigation and role agents.', '应用首页、导航与角色智能体。'),
                )
              }
            />
          </SettingsGroup>
        )}
        <SettingsSection title={tr('Interface changes', '界面变化')}>
          <SettingsGroup>
            {application && (
              <>
                <ReviewRow
                  label={tr('Home page', '首页')}
                  value={declaration.presentation?.home ? pageName(declaration.presentation.home) : host}
                />
                <ReviewRow
                  label={tr('Navigation shown', '显示的导航')}
                  value={list(
                    navigation?.entries?.map(pageName),
                    navigation?.entries ? none : tr('Official navigation', '官方导航'),
                  )}
                />
                <ReviewRow
                  label={tr('Official entries hidden', '隐藏的官方入口')}
                  value={list([
                    ...new Set(
                      navigation?.hideBuiltin?.map((entry) =>
                        tr(...(navigationLabels[entry] ?? [entry, entry])),
                      ),
                    ),
                  ])}
                />
              </>
            )}
            {preview.replacedRoles.map((value) => {
              const item = object(value)
              return (
                <ReviewRow
                  key={JSON.stringify(value)}
                  label={role(text(item?.role))}
                  value={strings(item?.visibleParts)
                    .map((part) => tr(...(partLabels[part] ?? [part, part])))
                    .join(', ')}
                />
              )
            })}
          </SettingsGroup>
        </SettingsSection>
        {application && (
          <SettingsSection title={tr('Included agents', '包含的智能体')}>
            {agents.length > 3 ? (
              <Disclosure
                variant="card"
                summary={tr(`${agents.length} role agents`, `${agents.length} 个角色智能体`)}
                description={
                  declaration.defaultAgent
                    ? tr(
                        `Default: ${agentName(declaration.defaultAgent)}`,
                        `默认：${agentName(declaration.defaultAgent)}`,
                      )
                    : undefined
                }
              >
                {agentRows}
              </Disclosure>
            ) : agents.length ? (
              agentRows
            ) : (
              <p>{tr('All available agents', '全部可用智能体')}</p>
            )}
          </SettingsSection>
        )}
        <SettingsSection title={tr('Permissions', '权限')}>
          <SettingsGroup>
            {application &&
              (access.size ? (
                [...access].map(([key, group]) => (
                  <ReviewRow
                    key={key}
                    label={
                      group.readOnly === undefined
                        ? tr('Launch access unavailable', '启动权限尚不可用')
                        : group.readOnly
                          ? tr('Read-only tools', '只读工具')
                          : tr('Tools can read and change data', '工具可读取及修改数据')
                    }
                    value={group.names.join(', ')}
                  />
                ))
              ) : (
                <ReviewRow
                  label={tr('Launch configuration unavailable', '启动配置尚不可用')}
                  value={tr('Each action will need a separate review.', '每项动作仍需单独审阅。')}
                />
              ))}
            {permissions.map((permission) => (
              <ReviewRow
                key={JSON.stringify(permission)}
                label={permission.label}
                value={permission.detail}
              />
            ))}
            <SettingsItem
              icon="shield-check"
              label={tr('Runtime restrictions and approvals still apply', '继续遵循运行限制与审批')}
              description={tr('Each agent uses its own reviewed tools.', '各角色使用各自已审阅的工具。')}
            />
          </SettingsGroup>
        </SettingsSection>
        <p className="agnes-settings-note">
          {preview.signature === 'verified'
            ? tr('Verified publisher', '发布者已验证')
            : tr(
                'Publisher not verified; review the source in technical details.',
                '发布者尚未验证，请在技术详情中审阅来源。',
              )}
        </p>
      </div>
      <SettingsTechnicalDetails title={tr('Technical details', '技术详情')} data-testid="consent-technical">
        <p>{tr('Trusted JavaScript is not a sandbox.', '受信 JavaScript 并非沙箱。')}</p>
        {diff?.status !== 'known' && (
          <p role="status">
            {diff?.status === 'not-applicable'
              ? tr(
                  'Dependency comparison is not applicable to an individual interface choice.',
                  '单独选择界面实现不适用依赖差异比较。',
                )
              : tr(
                  'The previously consented dependency closure is unavailable. Changes are unknown.',
                  '无法恢复此前已同意的依赖闭包，依赖差异未知。',
                )}
          </p>
        )}
        <SettingsCode label={tr('Reviewed payload and digests', '已审阅内容与摘要')} copy={raw}>
          {raw}
        </SettingsCode>
      </SettingsTechnicalDetails>
    </div>
  )
}
