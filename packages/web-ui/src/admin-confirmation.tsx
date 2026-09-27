import type {
  Capabilities,
  PackageBlocker,
  PackageContributionSummary,
  PackageInstalledDescriptor,
  PackagePreview,
  SurfaceServiceGrant,
} from '@agnes/protocol'
import { isWebClientModuleSlotName } from '@agnes/protocol'
import type { JSX, ReactNode } from 'react'
import { blockerText, sourceLabel } from './admin-text.js'

type Fact = readonly [label: string, value: string]

function FactsList({ items }: { items: readonly Fact[] }): JSX.Element {
  return (
    <dl className="confirm-facts-list">
      {items.map(([label, value]) => (
        <Fragmented key={`${label}:${value}`} label={label} value={value} />
      ))}
    </dl>
  )
}

function Fragmented({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  )
}

function ReviewSection({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <details className="confirm-review-section">
      <summary>{title}</summary>
      <div className="confirm-review-content">{children}</div>
    </details>
  )
}

function TextList({ items, empty }: { items: readonly string[]; empty: string }): JSX.Element {
  if (!items.length) return <p className="confirm-empty-fact">{empty}</p>
  return (
    <ul>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  )
}

function serviceGrant(grant: SurfaceServiceGrant): string {
  return `${grant.extension} · ${grant.name} · ${grant.range}`
}

function capabilityLines(capabilities: Capabilities): string[] {
  const lines: string[] = []
  if (capabilities.tools) {
    const names = capabilities.tools.names?.length
      ? `；名称 ${capabilities.tools.names.join('、')}`
      : '；未报告具体名称'
    lines.push(`工具：前缀 ${capabilities.tools.prefix || '（无前缀）'}${names}`)
  }
  if (capabilities['tools.invoke'] !== undefined)
    lines.push(`调用其他工具：${capabilities['tools.invoke'] ? '允许' : '不允许'}`)
  if (capabilities.hooks?.length) lines.push(`钩子：${capabilities.hooks.join('、')}`)
  if (capabilities.slots?.length) lines.push(`界面插槽：${capabilities.slots.join('、')}`)
  if (capabilities.events !== undefined) lines.push(`事件：${capabilities.events ? '允许' : '不允许'}`)
  if (capabilities.resources?.length) lines.push(`资源：${capabilities.resources.join('、')}`)
  if (capabilities.network !== undefined) {
    lines.push(
      Array.isArray(capabilities.network)
        ? '网络：未授予主机访问权限'
        : `网络主机：${capabilities.network.hosts.join('、')}`,
    )
  }
  if (capabilities.artifacts !== undefined) lines.push(`工件：${capabilities.artifacts ? '允许' : '不允许'}`)
  if (capabilities['network.publicRead'] !== undefined)
    lines.push(`公开网页读取：${capabilities['network.publicRead'] ? '允许（匿名、限额）' : '不允许'}`)
  if (capabilities.subagent !== undefined) lines.push(`子代理：${capabilities.subagent ? '允许' : '不允许'}`)
  for (const service of capabilities.services ?? []) {
    lines.push(`服务：${service.name}（${service.kind}，超时 ${service.timeoutMs}ms）`)
  }
  for (const projection of capabilities.projections ?? []) {
    lines.push(
      `投影：${projection.name}（输入 ${projection.inputEventTypes.join('、')}，状态上限 ${projection.maxStateBytes} B）`,
    )
  }
  return lines
}

function contributionLines(contribution: PackageContributionSummary): string[] {
  const lines = [`${contribution.kind} · ${contribution.id}`]
  switch (contribution.kind) {
    case 'client':
      return [
        ...lines,
        `描述：${contribution.path}`,
        `后端行：${contribution.rowId}`,
        ...('client' in contribution ? [`浏览器入口：${contribution.client.entry}`] : []),
        ...('client' in contribution && contribution.client.services?.length
          ? [`查询服务：${contribution.client.services.join('、')}`]
          : []),
      ]
    case 'extension': {
      lines.push(`入口：${contribution.path}`, `API 范围：${contribution.apiRange}`)
      if (contribution.runtimeSupports?.length)
        lines.push(`运行方式：${contribution.runtimeSupports.join('、')}`)
      const declared = capabilityLines(contribution.capabilities)
      lines.push(
        ...(declared.length
          ? declared
          : ['此扩展未在 capability 字段中报告能力；不能由此推断整个包没有能力。']),
      )
      const clientSlots = contribution.client?.slots ?? []
      if (clientSlots.length) {
        lines.push(`浏览器 UI 槽位：${clientSlots.join('、')}`)
        const unsupported = clientSlots.filter((slot) => !isWebClientModuleSlotName(slot))
        if (unsupported.length)
          lines.push(`Web 宿主暂不支持：${unsupported.join('、')}；安装后不会发布浏览器 UI。`)
      }
      return lines
    }
    case 'seam':
      return [
        ...lines,
        `入口：${contribution.path}`,
        `API 范围：${contribution.apiRange}`,
        `提供：${contribution.provides.join('、')}`,
      ]
    case 'provider':
    case 'runtime':
      return [...lines, `入口：${contribution.path}`, `API 范围：${contribution.apiRange}`]
    case 'skill':
    case 'preset':
      return [...lines, `入口：${contribution.path}`]
    case 'surface': {
      const { descriptor } = contribution
      const artifact =
        descriptor.artifact.kind === 'node' ? descriptor.artifact.entry : descriptor.artifact.image
      return [
        ...lines,
        `表面：${descriptor.id}`,
        `API 范围：${descriptor.apiRange}`,
        `工件：${descriptor.artifact.kind} · ${artifact}`,
        `健康检查：${descriptor.healthPath}`,
        ...(descriptor.requires.services.length
          ? descriptor.requires.services.map((grant) => `所需服务：${serviceGrant(grant)}`)
          : ['未报告所需服务授权。']),
      ]
    }
  }
}

function Contributions({ values }: { values: readonly PackageContributionSummary[] }): JSX.Element {
  if (!values.length) {
    return <TextList items={[]} empty="后台未报告贡献；请仍核对本次安装的完整性摘要。" />
  }
  return (
    <ul className="confirm-contributions">
      {values.map((contribution) => (
        <li key={`${contribution.kind}:${contribution.id}:${contributionLines(contribution).join('|')}`}>
          {contributionLines(contribution).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </li>
      ))}
    </ul>
  )
}

function Blockers({ values }: { values: readonly PackageBlocker[] }): JSX.Element {
  return <TextList items={values.map(blockerText)} empty="后台未报告阻断项。" />
}

function CapabilityDiff({ preview }: { preview: PackagePreview }): JSX.Element {
  const diff = preview.capabilityDiff
  const changes = [
    ...diff.added.map((item) => `新增能力：${item}`),
    ...diff.removed.map((item) => `移除能力：${item}`),
    ...diff.runtimeSupportRemoved.map((item) => `不再支持运行方式：${item}`),
    ...diff.dependenciesAdded.map((item) => `新增依赖：${item}`),
    ...diff.serviceGrantsAdded.map((item) => `新增服务授权：${serviceGrant(item)}`),
  ]
  return <TextList items={changes} empty="后台未报告相对于当前基线的能力差异；这不表示这个包不包含能力。" />
}

function Dependencies({ entries }: { entries: Readonly<Record<string, string>> }): JSX.Element {
  return (
    <TextList
      items={Object.entries(entries).map(([name, range]) => `${name} · ${range}`)}
      empty="后台未报告依赖项。"
    />
  )
}

function Warnings({ preview }: { preview: PackagePreview }): JSX.Element {
  return (
    <TextList
      items={preview.warnings.map((warning) => `${warning.code}：${warning.safeMessage}`)}
      empty="后台未报告警告。"
    />
  )
}

/** Renders the exact preview DTO as inert text nodes before an install or update is confirmed. */
export function PreviewConfirmationFacts({ preview }: { preview: PackagePreview }): JSX.Element {
  return (
    <>
      <p className="confirm-facts-lead">请核对完整性、能力摘要及以下后台已报告的安装事实。</p>
      <FactsList
        items={[
          ['版本', preview.version],
          ['来源', sourceLabel(preview.source)],
          ['完整性摘要', preview.integrity],
          [
            '能力摘要哈希',
            preview.capabilityHash ?? '后台未报告能力摘要哈希；此预览不能据此作为信任决定的依据。',
          ],
          ['许可证', preview.license],
          ['溯源签名', preview.provenance.signatureVerified ? '已验证' : '未验证'],
        ]}
      />
      <ReviewSection title="来源与溯源">
        <FactsList
          items={[
            ['溯源来源', sourceLabel(preview.provenance.source)],
            ['溯源完整性', preview.provenance.integrity],
            ['发布时间', preview.provenance.releasedAt ?? '后台未报告发布时间'],
            ['签名验证', preview.provenance.signatureVerified ? '已验证' : '未验证'],
          ]}
        />
      </ReviewSection>
      <ReviewSection title="贡献与已报告能力">
        <Contributions values={preview.contributions} />
      </ReviewSection>
      <ReviewSection title="能力差异与服务授权">
        <CapabilityDiff preview={preview} />
      </ReviewSection>
      <ReviewSection title="依赖与许可证">
        <FactsList items={[['许可证', preview.license]]} />
        <Dependencies entries={preview.dependencies} />
      </ReviewSection>
      <ReviewSection title="警告与阻断项">
        <Warnings preview={preview} />
        <Blockers values={preview.blockers} />
      </ReviewSection>
    </>
  )
}

/** Renders the installed DTO that will be bound by a trust decision. */
export function TrustConfirmationFacts({ item }: { item: PackageInstalledDescriptor }): JSX.Element {
  return (
    <>
      <p className="confirm-facts-lead">信任决定会绑定下列完整性摘要与能力摘要哈希；信任本身不会启用插件。</p>
      <FactsList
        items={[
          ['版本', item.version],
          ['来源', sourceLabel(item.source)],
          ['完整性摘要', item.integrity],
          ['能力摘要哈希', item.capabilityHash ?? '后台未报告能力摘要哈希'],
        ]}
      />
      <ReviewSection title="已报告的贡献与能力字段">
        <Contributions values={item.contributions} />
      </ReviewSection>
      <ReviewSection title="当前阻断项">
        <Blockers values={item.blockers} />
      </ReviewSection>
    </>
  )
}

/** Renders the immutable baselines that make a trust revocation race-safe. */
export function UntrustConfirmationFacts({ item }: { item: PackageInstalledDescriptor }): JSX.Element {
  return (
    <>
      <p className="confirm-facts-lead">
        撤销信任会绑定下列完整性摘要与能力摘要哈希，立刻停用此包，并从恢复与回滚候选中移除。再次使用必须重新预览并信任。
      </p>
      <FactsList
        items={[
          ['版本', item.version],
          ['来源', sourceLabel(item.source)],
          ['完整性摘要', item.integrity],
          ['能力摘要哈希', item.capabilityHash ?? '后台未报告能力摘要哈希'],
        ]}
      />
      <ReviewSection title="将被撤销的贡献与能力字段">
        <Contributions values={item.contributions} />
      </ReviewSection>
      <ReviewSection title="当前阻断项">
        <Blockers values={item.blockers} />
      </ReviewSection>
    </>
  )
}

/** Shows both immutable baselines bound by an atomic update-and-activate confirmation. */
export function UpdateActivationFacts({
  installed,
  preview,
}: {
  installed: PackageInstalledDescriptor
  preview: PackagePreview
}): JSX.Element {
  return (
    <>
      <PreviewConfirmationFacts preview={preview} />
      <ReviewSection title="当前安装与运行基线">
        <FactsList
          items={[
            ['当前安装版本', installed.version],
            ['当前安装摘要', installed.integrity],
            ['当前运行版本', installed.actualVersion ?? '后台未确认'],
            [
              '当前运行摘要',
              installed.actualIntegrity ?? (installed.actual === 'not-running' ? '未运行' : '后台未确认'),
            ],
            ['目标信任摘要', preview.integrity],
            ['目标能力摘要哈希', preview.capabilityHash ?? '后台未报告，不能组合激活'],
          ]}
        />
      </ReviewSection>
    </>
  )
}

/** Shows the verified rollback target and current baselines without exposing internal tree hashes. */
export function RollbackActivationFacts({
  installed,
}: {
  installed: PackageInstalledDescriptor
}): JSX.Element {
  const target = installed.rollbackTarget
  return (
    <>
      <p className="confirm-facts-lead">回滚确认会绑定后台已核验的目标、当前安装摘要和当前运行摘要。</p>
      <FactsList
        items={[
          ['当前安装版本', installed.version],
          ['当前安装摘要', installed.integrity],
          ['当前运行版本', installed.actualVersion ?? '后台未确认'],
          [
            '当前运行摘要',
            installed.actualIntegrity ?? (installed.actual === 'not-running' ? '未运行' : '后台未确认'),
          ],
          ['回滚目标版本', target?.version ?? '后台未提供已核验目标'],
          ['回滚目标摘要', target?.integrity ?? '后台未提供已核验目标'],
          ['目标能力摘要哈希', target?.capabilityHash ?? '后台未提供已核验目标'],
        ]}
      />
      <ReviewSection title="当前阻断项">
        <Blockers values={installed.blockers} />
      </ReviewSection>
    </>
  )
}
