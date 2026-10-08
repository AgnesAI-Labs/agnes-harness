import { RESOURCE_CONTROL_METHODS } from '@agnes/protocol'
import {
  type ConfigSchema,
  configIssues,
  createCatalogTranslator,
  type LocaleTranslator,
} from '@agnes/web-ui'
import { resourceAdminLocaleCatalog } from './locales/admin.js'

const englishText = createCatalogTranslator(resourceAdminLocaleCatalog, 'en')

/**
 * 表单字段的即时正则校验。正则与条数上限**直接取自 resource-control-contracts 生成的 JSON
 * Schema**（经 @agnes/protocol re-export），不做第二份手写镜像——schema 改了这里自动跟上，
 * 不会出现"前端放行、后台拒绝"或反过来的漂移。后台仍是权威；本模块只负责在输入阶段就给出
 * 按字段的中文提示，而不是等提交后收到一条笼统的「资源管理参数无效」。
 */
type SchemaNode = {
  pattern?: string
  minLength?: number
  maxLength?: number
  maxItems?: number
  properties?: Record<string, SchemaNode>
  items?: SchemaNode
  $defs?: Record<string, SchemaNode>
}

const CREATE_PARAMS = RESOURCE_CONTROL_METHODS['_agnes/v1/mcp.servers.create'].params as unknown as SchemaNode

/**
 * 按路径取 schema 节点。每段是 $defs 的 def 名或对象属性名（`args.items` 里的 `items`
 * 例外，指数组元素 schema 容器本身）。例如 'McpStdioTransport.executable'。
 */
function schemaNode(path: string): SchemaNode {
  let node: SchemaNode | undefined = CREATE_PARAMS
  for (const key of path.split('.')) {
    node = node?.$defs?.[key] ?? node?.properties?.[key] ?? (key === 'items' ? node?.items : undefined)
    if (!node) throw new Error(`MCP form schema node missing: ${path}`)
  }
  return node
}

function schemaPattern(path: string): RegExp {
  const source = schemaNode(path).pattern
  if (!source) throw new Error(`MCP form schema pattern missing: ${path}`)
  return new RegExp(source)
}

function schemaNumber(path: string, limit: 'maxLength' | 'maxItems'): number {
  const value = schemaNode(path)[limit]
  if (value === undefined) throw new Error(`MCP form schema limit missing: ${path}.${limit}`)
  return value
}

/** 各输入框的正则。key 与 schema $defs 对应，供测试与报错文案引用。 */
export const MCP_FORM_PATTERNS = {
  serverId: schemaPattern('ServerId'),
  executable: schemaPattern('McpStdioTransport.executable'),
  arg: schemaPattern('McpStdioTransport.args.items'),
  toolName: schemaPattern('McpToolPolicy.allow.items'),
  secretRef: schemaPattern('SecretRef'),
  envName: schemaPattern('McpEnvName'),
  url: schemaPattern('McpHttpTransport.url'),
} as const

export const MCP_FORM_LIMITS = {
  argMaxLength: schemaNumber('McpStdioTransport.args.items', 'maxLength'),
  argsMaxItems: schemaNumber('McpStdioTransport.args', 'maxItems'),
  toolMaxLength: schemaNumber('McpToolPolicy.allow.items', 'maxLength'),
  toolsMaxItems: schemaNumber('McpToolPolicy.allow', 'maxItems'),
  urlMaxLength: schemaNumber('McpHttpTransport.url', 'maxLength'),
} as const

/** Shared UI schema validation keeps the existing managed MCP form/confirmation DOM intact. */
export const MCP_FORM_SCHEMAS: Readonly<Record<keyof typeof MCP_FORM_PATTERNS, ConfigSchema>> =
  Object.fromEntries(
    Object.entries(MCP_FORM_PATTERNS).map(([key, regex]) => [
      key,
      {
        type: 'string',
        pattern: regex.source,
        ...(key === 'secretRef' ? { format: 'credential-reference' as const } : {}),
      },
    ]),
  ) as Record<keyof typeof MCP_FORM_PATTERNS, ConfigSchema>
const matchesField = (key: keyof typeof MCP_FORM_SCHEMAS, value: string) =>
  configIssues(MCP_FORM_SCHEMAS[key], value).length === 0

export type McpFormFieldId = 'mcp-id' | 'mcp-executable' | 'mcp-args' | 'mcp-url' | 'mcp-secret' | 'mcp-tools'

export type McpFormFieldIssue = Readonly<{
  field: McpFormFieldId
  message: string
}>

export type McpFormFieldSnapshot = Readonly<{
  /** select 的原样取值；未知值跳过传输相关校验，由 definitionFromForm 在提交时报错。 */
  transport: string
  secretKind: string
  serverId: string
  executable: string
  argsText: string
  url: string
  secretText: string
  toolsText: string
}>

const URL_CREDENTIAL_QUERY = /(?:token|secret|password|api[_-]?key|credential)/i

const lines = (value: string): string[] =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

function urlIssues(url: string, t: LocaleTranslator): McpFormFieldIssue[] {
  if (!url) return []
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return [{ field: 'mcp-url', message: t('validation.url-format') }]
  }
  if (parsed.username || parsed.password || parsed.hash)
    return [
      {
        field: 'mcp-url',
        message: t('validation.url-no-credentials'),
      },
    ]
  if ([...parsed.searchParams.keys()].some((name) => URL_CREDENTIAL_QUERY.test(name)))
    return [
      {
        field: 'mcp-url',
        message: t('validation.url-no-secret-query'),
      },
    ]
  if (url.length > MCP_FORM_LIMITS.urlMaxLength || !matchesField('url', url))
    return [
      {
        field: 'mcp-url',
        message: t('validation.url-secure'),
      },
    ]
  return []
}

function stdioIssues(executable: string, argsText: string, t: LocaleTranslator): McpFormFieldIssue[] {
  const issues: McpFormFieldIssue[] = []
  if (executable && !matchesField('executable', executable))
    issues.push({
      field: 'mcp-executable',
      message: t('validation.executable'),
    })
  const args = lines(argsText)
  if (args.length > MCP_FORM_LIMITS.argsMaxItems)
    issues.push({
      field: 'mcp-args',
      message: t('validation.args-limit', { count: MCP_FORM_LIMITS.argsMaxItems }),
    })
  const badIndex = args.findIndex(
    (arg) => arg.length > MCP_FORM_LIMITS.argMaxLength || !matchesField('arg', arg),
  )
  if (badIndex >= 0)
    issues.push({
      field: 'mcp-args',
      message: t('validation.arg-invalid', { index: badIndex + 1 }),
    })
  return issues
}
function secretIssues(secretKind: string, secretText: string, t: LocaleTranslator): McpFormFieldIssue[] {
  if (secretKind === 'none') return []
  if (secretKind === 'stdio-env') {
    for (const [index, line] of lines(secretText).entries()) {
      const at = line.indexOf('=')
      const name = at < 1 ? '' : line.slice(0, at)
      const reference = line.slice(at + 1)
      if (!name || !matchesField('envName', name))
        return [
          {
            field: 'mcp-secret',
            message: t('validation.env-name', { index: index + 1 }),
          },
        ]
      if (!matchesField('secretRef', reference))
        return [
          {
            field: 'mcp-secret',
            message: t('validation.env-ref', { index: index + 1 }),
          },
        ]
    }
    return []
  }
  if (secretText && !matchesField('secretRef', secretText))
    return [
      {
        field: 'mcp-secret',
        message: t('validation.secret-ref'),
      },
    ]
  return []
}

function toolIssues(toolsText: string, t: LocaleTranslator): McpFormFieldIssue[] {
  const tools = lines(toolsText)
  if (tools.length > MCP_FORM_LIMITS.toolsMaxItems)
    return [
      {
        field: 'mcp-tools',
        message: t('validation.tools-limit', { count: MCP_FORM_LIMITS.toolsMaxItems }),
      },
    ]
  const badIndex = tools.findIndex(
    (tool) => tool.length > MCP_FORM_LIMITS.toolMaxLength || !matchesField('toolName', tool),
  )
  if (badIndex >= 0)
    return [
      {
        field: 'mcp-tools',
        message: t('validation.tool-name', { index: badIndex + 1 }),
      },
    ]
  const duplicated = tools.find((tool, index) => tools.indexOf(tool) !== index)
  if (duplicated)
    return [
      {
        field: 'mcp-tools',
        message: t('validation.tool-duplicate', { name: duplicated }),
      },
    ]
  return []
}

/**
 * 汇总表单当前的按字段问题。`requireFilled` 关掉时只校验非空值（输入过程中的即时反馈，
 * 不在用户还没填到时催促）；打开时把「必填但为空」也算问题（提交前的最终把关）。
 */
export function mcpFormIssues(
  snapshot: McpFormFieldSnapshot,
  options: { requireFilled: boolean },
  t: LocaleTranslator = englishText,
): McpFormFieldIssue[] {
  const issues: McpFormFieldIssue[] = []
  if (!snapshot.serverId) {
    if (options.requireFilled) issues.push({ field: 'mcp-id', message: t('validation.server-id-required') })
  } else if (!MCP_FORM_PATTERNS.serverId.test(snapshot.serverId)) {
    issues.push({
      field: 'mcp-id',
      message: t('validation.server-id-format'),
    })
  }
  if (snapshot.transport === 'stdio') {
    if (!snapshot.executable) {
      if (options.requireFilled)
        issues.push({ field: 'mcp-executable', message: t('validation.executable-required') })
    }
    issues.push(...stdioIssues(snapshot.executable, snapshot.argsText, t))
  } else if (snapshot.transport === 'http' || snapshot.transport === 'sse') {
    if (!snapshot.url) {
      if (options.requireFilled)
        issues.push({
          field: 'mcp-url',
          message: t('validation.url-required'),
        })
    } else issues.push(...urlIssues(snapshot.url, t))
  }
  if (!snapshot.secretText && snapshot.secretKind !== 'none' && options.requireFilled)
    issues.push({ field: 'mcp-secret', message: t('error.form.secret') })
  else issues.push(...secretIssues(snapshot.secretKind, snapshot.secretText, t))
  issues.push(...toolIssues(snapshot.toolsText, t))
  return issues
}
