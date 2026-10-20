import type { ApplicationPreview, PresentationRole } from '@agnes/protocol'
import { resolveApplicationBrand } from '@agnes/web-client'
import { SettingsCode, SettingsTechnicalDetails, useDocumentLanguage } from '@agnes/web-ui'
import { useEffect, useState } from 'react'

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

function PreviewBrand({ preview }: { preview: ApplicationPreview }) {
  const [mark, setMark] = useState<string>()
  const language = useDocumentLanguage()
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
  }, [preview])
  const brand = resolveApplicationBrand(preview.declaration, language)
  return (
    <p>
      {mark ? (
        <img src={mark} alt="" width={32} height={32} onError={() => setMark(undefined)} />
      ) : (
        <span className="agnes-mark" aria-hidden="true" />
      )}{' '}
      {brand.name} · {brand.title} · {brand.assistantName}
    </p>
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
  store: ['Store data', '存储数据'],
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
}
function permissionLines(value: unknown, tr: Text, path = ''): string[] {
  if (Array.isArray(value))
    return value.length
      ? value.flatMap((item) => permissionLines(item, tr, path))
      : [`${path}: ${tr('None declared', '未声明')}`]
  const fields = object(value)
  if (fields)
    return Object.entries(fields).flatMap(([key, value]) =>
      permissionLines(
        value,
        tr,
        [path, tr(...(permissionLabels[key] ?? [key, key]))].filter(Boolean).join(' · '),
      ),
    )
  return [
    `${path}: ${typeof value === 'boolean' ? (value ? tr('Allowed', '允许') : tr('Not requested', '未请求')) : String(value)}`,
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

/** A projection of the reviewed payload only; the original digest and write contract stay intact. */
export function ApplicationPreviewSummary({
  preview,
  application = false,
}: {
  preview: ApplicationPreview
  application?: boolean
}) {
  const language = useDocumentLanguage()
  const tr: Text = (en, zh) => (language === 'zh-CN' ? zh : en)
  const { declaration } = preview
  const navigation = declaration.presentation?.navigation
  const none = tr('None', '无')
  const host = tr('Host default', '宿主默认')
  const role = (name: string) => tr(...(PRESENTATION_ROLE_LABELS[name as PresentationRole] ?? [name, name]))
  const list = (values: readonly string[] | undefined, fallback = none) => values?.join(', ') || fallback
  const diff = object(preview.dependencyDiff)
  const raw = JSON.stringify(preview, null, 2)
  return (
    <>
      <div data-testid="consent-summary">
        {application && (
          <>
            <h4>{tr('Brand', '品牌')}</h4>
            <PreviewBrand preview={preview} />
            <h4>{tr('Pages and navigation', '页面与导航')}</h4>
            <p>
              {tr('Home / skin', '主页 / 皮肤')}:{' '}
              {declaration.presentation?.home ? tr('Application home page', '应用首页') : host} /{' '}
              {declaration.presentation?.skin ? tr('Application theme', '应用主题') : host}
            </p>
            <p>
              {tr('Navigation pages', '导航页面')}:{' '}
              {navigation?.entries
                ? tr(
                    `${navigation.entries.length} application pages`,
                    `${navigation.entries.length} 个应用页面`,
                  )
                : host}
            </p>
            <p>
              {tr('Hidden host entries', '隐藏的宿主入口')}:{' '}
              {list([
                ...new Set(
                  navigation?.hideBuiltin?.map((entry) => tr(...(navigationLabels[entry] ?? [entry, entry]))),
                ),
              ])}
            </p>
            <h4>{tr('Agents', '智能体')}</h4>
            <p>
              {tr('Visible agents', '可见智能体')}:{' '}
              {declaration.agents
                ? tr(
                    `${declaration.agents.length} application agents`,
                    `${declaration.agents.length} 个应用智能体`,
                  )
                : tr('All available agents', '全部可用智能体')}
            </p>
            <p>
              {tr('Default agent', '默认智能体')}:{' '}
              {declaration.defaultAgent
                ? tr('Chosen by this application', '由应用指定')
                : tr('General assistant', '通用助手')}
            </p>
          </>
        )}
        <h4>{tr('Interface changes', '界面变化')}</h4>
        {preview.replacedRoles.length ? (
          <ul>
            {preview.replacedRoles.map((value) => {
              const item = object(value)
              return (
                <li key={JSON.stringify(value)}>
                  {role(text(item?.role))}
                  {strings(item?.visibleParts).length > 0 && (
                    <p>
                      {tr('Visible parts replaced', '将替换的可见部分')}:{' '}
                      {strings(item?.visibleParts)
                        .map((part) => tr(...(partLabels[part] ?? [part, part])))
                        .join(', ')}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        ) : (
          <p>{tr('No role replacements', '不替换接管角色')}</p>
        )}
        <h4>{tr('Dependencies, permissions and changes', '依赖、权限和变化')}</h4>
        {diff?.status === 'known' ? (
          <>
            <p>
              {tr('Added dependencies', '新增依赖')}: {strings(diff.added).length}
            </p>
            <p>
              {tr('Removed dependencies', '移除依赖')}: {strings(diff.removed).length}
            </p>
          </>
        ) : (
          <p role="status">
            {diff?.status === 'not-applicable'
              ? tr(
                  'Dependency comparison is not applicable to an individual interface choice. Review its current permissions below.',
                  '单独选择界面实现不适用依赖差异比较，请审阅下方当前权限。',
                )
              : tr(
                  'The previously consented dependency closure is unavailable. Changes are unknown.',
                  '无法恢复此前已同意的依赖闭包，依赖差异未知。',
                )}
          </p>
        )}
        {preview.dependencies.length ? (
          <ul>
            {preview.dependencies.map((value) => {
              const item = object(value)
              const capabilities = object(item?.capabilities)
              const permissions = capabilities ? permissionLines(capabilities, tr) : []
              return (
                <li key={JSON.stringify(value)}>
                  {tr('Required plugin', '所需插件')} · {text(item?.version)}
                  <ul>
                    {(capabilities
                      ? permissions.length
                        ? permissions
                        : [tr('No capabilities requested.', '未请求额外能力。')]
                      : [
                          tr(
                            'Permission declaration unavailable; review technical details.',
                            '权限声明不可用，请查看技术详情。',
                          ),
                        ]
                    ).map((permission) => (
                      <li key={permission}>{permission}</li>
                    ))}
                  </ul>
                </li>
              )
            })}
          </ul>
        ) : (
          <p>{tr('No dependencies reported', '未报告依赖')}</p>
        )}
        <p>
          {tr('Version', '版本')}: {preview.version}
        </p>
        <p>
          {preview.signature === 'verified'
            ? tr('Verified publisher', '发布者已验证')
            : tr(
                'Publisher not verified; review the source in technical details.',
                '发布者尚未验证，请在技术详情中审阅来源。',
              )}
        </p>
      </div>
      <SettingsTechnicalDetails title={tr('Technical details', '技术详情')} data-testid="consent-technical">
        <SettingsCode label={tr('Reviewed payload and digests', '已审阅内容与摘要')} copy={raw}>
          {raw}
        </SettingsCode>
      </SettingsTechnicalDetails>
    </>
  )
}
