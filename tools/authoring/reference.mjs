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
function iface(path, name) {
  const source = read(`packages/extension-api/src/${path}.ts`)
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
  const toolMembers = tool.map((m) => m.name)
  const fs = tool.find((m) => m.name === 'fs').text
  const execute = iface('tool', 'ToolDef').find((m) => m.name === 'execute').text
  const store = declarations(iface('profile-services', 'OwnedStore'))
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
    fs,
    execute,
    store,
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
fs.read returns bytes (Uint8Array); offset/limit are bytes. Decode text with new TextDecoder().decode(await ctx.fs.read(path)); write accepts bytes or a string. execute(args, ctx) receives the invocation context. fs is policy-controlled WORKSPACE access, never a private plugin directory. Use ctx.signal for cancellation; never bypass a denial with ambient Node I/O. / read 返回字节，offset/limit 以字节计；用 TextDecoder 解码。write 接受字节或字符串。fs 是受策略约束的工作区访问，不是插件私有存储；不得通过 Node I/O 绕过拒绝。

Choose data ownership first / 先确定数据归属:
- Workspace files: ToolContext.fs.read/write, relative to the invocation workspace (ctx.session.workspaceRoot); preserve normal authorization. / 工作区文件用工具调用的 fs，遵循工作区授权。
- Plugin/app profile data: optional ToolContext.store or ServiceContext.store (OwnedStore), with reviewed capabilities.store: true. Host binds the profile and plugin owner; no caller-selected directory/owner/SQL. Refuse clearly when unavailable. / 插件或应用数据用声明 store 能力的命名空间 JSON 存储；缺少能力时明确拒绝。
- Managed profile resources: PluginContext.profileRuntime.register(definition), start(init).store; reviewed managedServices owns lifecycle. / 托管服务通过 profileRuntime 的 start(init).store 存储。
- Session facts: eventLog.append and projections for session ledger state, not arbitrary private files; artifacts for output blobs. External business data belongs behind an explicitly declared service/provider. / 会话事实用事件日志与投影，输出用 artifacts，外部业务数据走明确声明的服务或 provider。
OwnedStore is bounded JSON; transaction callbacks are synchronous, promises abort. / OwnedStore 存储有限 JSON，事务回调必须同步。
${code(store.join('\n'))}

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
