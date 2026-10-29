import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createScanner } from 'typescript/unstable/ast/scanner'

const root = new URL('../../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
// Use the pinned compiler's scanner, including string/comment handling, to find matching braces.
function block(source, from) {
  const scanner = createScanner(true, 0, source.slice(from))
  const eof = createScanner(true, 0, '').scan()
  let start,
    depth = 0
  while (scanner.scan() !== eof) {
    const text = scanner.getTokenText()
    if (text === '{') {
      start ??= scanner.getTokenEnd()
      depth++
    }
    if (text === '}' && --depth === 0) return source.slice(from + start, from + scanner.getTokenStart())
  }
  throw new Error('Unclosed source declaration')
}
function iface(path, name, pkg = 'extension-api') {
  const source = read(`packages/${pkg}/src/${path}.ts`)
  const start = source.indexOf(`export interface ${name}`)
  if (start < 0) throw new Error(`Missing public interface ${name}`)
  const body = block(source, start)
  const members = [...body.matchAll(/^ {2}(?:readonly )?([A-Za-z]+)[?<(:]/gm)]
  return members.map((member, i) => ({
    name: member[1],
    text: body
      .slice(member.index, members[i + 1]?.index ?? body.length)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
      .replace(/[ \t]+$/gm, '')
      .trim(),
  }))
}
const declarations = (members) => members.map((m) => m.text)

/** Derived from the validator whitelist, rendered-region contract and public TypeScript declarations. */
export function generateReference() {
  const tokenSource = read('packages/extension-api/src/generated/theme-tokens.ts')
  const tokens = [...tokenSource.split('] as const')[0].matchAll(/"(--[a-z0-9-]+)"/g)].map((m) => m[1])
  // EXPECTED is the existing region contract checked against the real rendered pages.
  const regionSource = read('packages/web/test/skin-regions.test.ts')
  const regionContract = block(regionSource, regionSource.indexOf('const EXPECTED:'))
  const regions = [
    ...new Set([...regionContract.matchAll(/^ {4}(?:'([a-z-]+)'|([a-z-]+)):/gm)].map((m) => m[1] ?? m[2])),
  ].sort()
  const facets = declarations(iface('plugin-context', 'PluginContextFacets'))
  const tool = iface('tool', 'ToolContext')
  const toolMeta = declarations(iface('tool', 'ToolMeta'))
  const policyTypes = ['ReplayPolicy', 'RiskClass'].map((name) => {
    const definition = new RegExp(`export type ${name} = ([^\n]+)`).exec(
      read('packages/extension-api/src/tool.ts'),
    )
    if (!definition) throw new Error(`Missing tool policy type ${name}`)
    return `type ${name} = ${definition[1]}`
  })
  const toolMembers = tool.map((m) => m.name)
  const fs = tool.find((m) => m.name === 'fs').text
  const execute = iface('tool', 'ToolDef').find((m) => m.name === 'execute').text
  const store = declarations(iface('profile-services', 'OwnedStore'))
  const browserContext = declarations(
    iface('client-module', 'ClientContext', 'web-client').filter((m) =>
      ['homeEntries', 'profile', 'sessionStreams'].includes(m.name),
    ),
  )
  const browserServices = declarations(iface('service-contracts', 'ClientProfileServices', 'web-client'))
  const importSource = read('packages/protocol/src/client-platform-imports.ts')
  const browserImports = [...importSource.matchAll(/^ {2}'([^']+)'/gm)].map((m) => m[1])
  const schema = JSON.parse(read('packages/protocol/schema/extension-manifest.json'))
  const skinModes = schema.$defs.SkinContribution.properties.tokens.additionalProperties.required
  const darkClass = /root\.classList\.toggle\('([^']+)', theme === 'dark'\)/.exec(
    read('packages/web-foundation/src/theme.ts'),
  )?.[1]
  if (!darkClass) throw new Error('Update author reference for changed root theme selection')
  const apiVersion = JSON.parse(read('packages/extension-api/package.json')).version
  const reference = {
    apiVersion,
    tokens,
    regions,
    facets,
    toolMembers,
    toolMeta,
    policyTypes,
    fs,
    execute,
    store,
    browserContext,
    browserServices,
    browserImports,
    skinModes,
    darkClass,
  }
  const code = (text) => `\`\`\`ts\n${text}\n\`\`\``
  const text = `Author reference / 作者参考 (extension-api ${apiVersion})
Generated from this release's sources; examples are not allowlists. / 由本版本源码生成；模板中的示例不是白名单。

PluginContext: apply(ctx) registers declared inject facets. No fs/readText/writeText here. / apply(ctx) 用于登记声明的 facet，没有 fs/readText/writeText。
${code(facets.join('\n'))}
ToolContext members / 工具调用上下文字段: ${toolMembers.join(', ')}.
${code(`${execute}\n${fs}`)}
Tool safety metadata / 工具安全元数据:
${code(`${policyTypes.join('\n')}\ninterface ToolMeta {\n${toolMeta.map((line) => `  ${line}`).join('\n')}\n}`)}
replay: 'safe' requires isReadOnly: true. For writes/appends use isReadOnly: false, replay: 'never'; idempotent requires proven duplicate suppression, not just a timestamped filename. requiresApproval only accepts 'never', 'destructive', 'always' or omission; 'default' is not a value. Approval does not repair an invalid replay declaration. / 写入用 never 重放策略；有真实去重才能用 idempotent；审批和重放互不替代，default 不是合法审批值。
fs.read returns bytes (Uint8Array); offset/limit are bytes. Decode text with new TextDecoder().decode(await ctx.fs.read(path)); write accepts bytes or a string. execute(args, ctx) receives the invocation context. fs is policy-controlled WORKSPACE access, never a private plugin directory. Use ctx.signal for cancellation; never bypass a denial with ambient Node I/O. / read 返回字节，offset/limit 以字节计；用 TextDecoder 解码。write 接受字节或字符串。fs 是受策略约束的工作区访问，不是插件私有存储；不得通过 Node I/O 绕过拒绝。

fs.write replaces the file content; it does not append. For cumulative records, preserve existing bytes or use exclusive fs.create for independent entries. Test two successive writes and read them back through the same stateful filesystem. Supply used I/O ports with createPluginTestHost(main, { context: { fs } }); the lightweight test Host does not automatically provide a real workspace. / write 覆盖原文，不是追加；累积记录须保留原内容或独占创建独立条目；有状态 fs 测试必须验证两次写入均保留。

Choose data ownership first / 先确定数据归属:
- Workspace files: ToolContext.fs.read/write, relative to the invocation workspace (ctx.session.workspaceRoot); preserve normal authorization. / 工作区文件用工具调用的 fs，遵循工作区授权。
- Plugin/app profile data: optional ToolContext.store or ServiceContext.store (OwnedStore), with reviewed capabilities.store: true. Host binds the profile and plugin owner; no caller-selected directory/owner/SQL. Refuse clearly when unavailable. / 插件或应用数据用声明 store 能力的命名空间 JSON 存储；缺少能力时明确拒绝。
- Managed profile resources: PluginContext.profileRuntime.register(definition), start(init).store; reviewed managedServices owns lifecycle. / 托管服务通过 profileRuntime 的 start(init).store 存储。
- Session facts: eventLog.append and projections for session ledger state, not arbitrary private files; artifacts for output blobs. External business data belongs behind an explicitly declared service/provider. / 会话事实用事件日志与投影，输出用 artifacts，外部业务数据走明确声明的服务或 provider。
OwnedStore is bounded JSON; transaction callbacks are synchronous, promises abort. / OwnedStore 存储有限 JSON，事务回调必须同步。
${code(store.join('\n'))}

Browser profile pages / 浏览器 profile 页面:
Import React from 'react'; use React.createElement for plain .js (no JSX compilation), or compile JSX before delivery. The Host import map supplies exactly: ${browserImports.join(', ')}. These are ESM imports, NOT globalThis.React or an injected h prop. / 从 react 导入 React；普通 JS 用 createElement，JSX 须先编译；不要猜测全局 React 或 h 注入。
${code(browserContext.join('\n'))}
ctx.homeEntries.register(entry) registers a declared homeEntries id and matching placement on an active profile-lifetime client. Returns a disposer; the Host also cleans it up on unload. entry.component is a React component receiving {context: {t, data?, selection?, ...}}; capture ClientContext from apply(ctx, config) for service access. No session is required. / 注册活动 profile 页面须匹配描述符的 id 和 placement；卸载自动清理。页面组件收到 context 呈现属性，服务上下文从 apply 闭包取得。
${code(browserServices.join('\n'))}
Declare exact backend names in client.services (agnes.client.json) and register scope: 'profile' services through backend ctx.services.register (inject services). Service names use lowercase alphanumeric dot segments, not npm hyphens. Service metadata/schemas must be plain JSON; strip TypeBox Kind symbols when reusing a tool schema. query resolves the output itself. effect returns a receipt with state and requires a stable operationId; readOperation reads that same id. Completed receipts are replayed; running/unknown outcomes must be inspected/reconciled, never blindly retried with a new id. Approval-required effects need the Host Approvals UI, then resubmission with the SAME id/input. Current activation, service allowlist and server authorization remain authoritative. / 服务名用小写字母数字点分段，不能含 npm 名称中的连字符；服务元数据须为纯 JSON，复用工具 schema 时先去除 TypeBox Kind 符号；query 直接返回 output，effect 返回含 state 的回执；保留 operationId，未知结果先查询核对，不盲目新建操作，审批由宿主完成。
There is no ctx.tools.invoke from the browser; call your own declared profile service. ctx.agnes.services.call is session-bound and is not a substitute for a profile page. ctx.agnes.services.effect(name, input, { operationId }) uses native session admission; retry uncertain work with the same id and input. ctx.sessionStreams.open binds the ready active session and aborts on session change; it needs declared stream and readService allowlists. / 浏览器没有 ctx.tools.invoke；调用自己声明的 profile service。不要把需要当前会话的 call 当作 profile 页面接口。session effect 沿用原生授权，结果不明时沿用原编号和参数核对。sessionStreams 绑定当前就绪会话，切换会话会中止，必须声明流与 readService 白名单。
Use public author APIs, the tool-with-panel template and this version-matched reference before editing. Never search Host/installed source, other workspaces, environment variables or credentials; use authorized workspace files and artifact references only. Keep queries/effects, loading/error states, owner-store and inherited interaction/restart tests together. / 先用本版本作者参考与模板；禁止翻查宿主或安装源码、其他工作区、环境变量与凭据；只用授权工作区文件及 artifact 引用；保留交互、持久化与错误测试。

Application workbench / 应用业务工作台:
Optional agnes.application.workbench declares tabs (max 8, unique id/title/icon/order, slot="workbench.panel", view="page" with page="package#declared-profile-page", or view="signatures"|"evidence", optional when="session"|"object"); actions (max 12, id/title/prompt, optional agent/defaultAgent, focusTab, object:{type,id}); scenarios (max 3 localized texts), includes (unique pages/tools/signatures/reports gallery features). Text requires en, optionally zh-CN, <=2048 chars each. Unknown slots and missing pages/agents are refused. Import openApplicationWork from '@agnes/web-client'; openApplicationWork(actionId,{type,id}) opens existing launch review and an editable human-readable request with a separate removable object-context chip. Submission keeps the structured context in durable content; the transcript restores the chip after reload. Page components receive context.selection.object/applicationPanel. Subscribe to ctx.session.projection and readiness, discard stale reads, unsubscribe; no polling. Signatures reuse Host decisions; browser object/role memory grants no authority. Main-session full access auto-confirms eligible business.confirm contracts for its human principal and records the automatic mode; other permission levels ask the human. Application delegableAgents (max 64, subset of launchable agents) permits subagent_spawn({role,task}) from an adopted application. Role children use fresh role composition and a captured parent authority intersection. Effects admitted without asking can run; tool effects needing human approval wait on the owning session surface, and only an authenticated human can answer once or reject. Unless the application declares delegatedFullAccess: true (requires delegableAgents), a parent in full access does not change this. With that declaration, while the parent session is in full access, Core's own tool permission gates of its roles are auto-allowed and recorded as full-access answers; switching the parent away from full access revokes them. Role-child business signatures, plugin gates and questions remain refused in every case; hand them back to the main assistant. The parent human card and Web Approvals tab show tool approval requests with role, child, effect and policy reason; no human surface means refusal. Parent or ancestor stop/close withdraws pending role approvals. The rendered role catalogue is bounded; every declared role remains available by exact ref. role with fork/model or an unlisted role fails without fallback. / 声明标签、业务操作和场景；对象通过独立可移除的上下文 chip 进入会话，提示文字可编辑，提交后可持久恢复；授权与签署仍归宿主。角色子代理的工具审批在父会话人类卡和 Web 审批标签展示，只能由人单次允许或拒绝；无人类界面则拒绝。角色不能业务签署，父会话完全访问也不例外；应用声明 delegatedFullAccess: true（须有 delegableAgents）后，父会话处于完全访问期间，角色的 Core 工具权限门自动放行并记录，切离完全访问即撤销，业务签署、插件门和提问仍一律拒绝；主会话完全访问可由 Host 自动确认符合合同的业务签署并记录自动模式。

Skin tokens / 完整皮肤 token 白名单 (${tokens.length}):
${code(tokens.join('\n'))}
Skin region selectors / 公开区域选择器:
${code(regions.map((name) => `[data-agnes-region="${name}"]`).join('\n'))}
Every overridden token requires BOTH {${skinModes.join(', ')}} values. The root .${darkClass} class selects dark mode; ordinary region CSS handles light mode, .${darkClass} [data-agnes-region="..."] overrides dark mode. Only listed tokens are accepted by the manifest validator; --agnes-text-* tokens above ARE supported, unknown tokens are refused. Internal classes/turn IDs are not public selectors. / 每个 token 必须同时提供 light、dark；区域 CSS 的深色覆盖使用根 .dark。上列 --agnes-text-* 均受支持，未知 token 拒绝。内部类名和 turn ID 不属于合同。`
  return { reference, text }
}

export function outputs() {
  const { reference, text } = generateReference()
  const generated = `// Generated by tools/authoring/reference.mjs; do not edit.\n// biome-ignore format: preserve generator output\nexport const authorReference = ${JSON.stringify(text)}\n// biome-ignore format: preserve generator output\nexport const authorContract = ${JSON.stringify(reference, null, 2)}\n`
  return {
    'packages/package-manager/bundled-plugins/plugin-helper/src/reference.generated.mjs': generated,
    'docs/reference/plugin-author-api.md': `# Plugin author reference\n\nEnglish | [简体中文](plugin-author-api.zh-CN.md)\n\n<!-- Generated by tools/authoring/reference.mjs; do not edit. -->\n\n${text}\n`,
    'docs/reference/plugin-author-api.zh-CN.md': `# 插件作者参考\n\n[English](plugin-author-api.md) | 简体中文\n\n<!-- Generated by tools/authoring/reference.mjs; do not edit. -->\n\n${text}\n`,
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [path, text] of Object.entries(outputs())) {
    if (process.argv.includes('--check')) {
      if (read(path) !== text) throw new Error(`Stale author reference: ${path}`)
    } else writeFileSync(new URL(path, root), text)
  }
}
