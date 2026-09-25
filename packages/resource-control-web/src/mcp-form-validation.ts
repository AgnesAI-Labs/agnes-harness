import { RESOURCE_CONTROL_METHODS } from '@agnes/protocol'

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

function urlIssues(url: string): McpFormFieldIssue[] {
  if (!url) return []
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return [{ field: 'mcp-url', message: '地址格式不正确，请填写完整 URL。' }]
  }
  if (parsed.username || parsed.password || parsed.hash)
    return [
      {
        field: 'mcp-url',
        message: '地址不能携带用户名、密码或 #fragment（凭据请用 SecretRef）。',
      },
    ]
  if ([...parsed.searchParams.keys()].some((name) => URL_CREDENTIAL_QUERY.test(name)))
    return [
      {
        field: 'mcp-url',
        message:
          '地址查询参数不能包含 token / secret / password / api-key / credential（凭据请用 SecretRef）。',
      },
    ]
  if (url.length > MCP_FORM_LIMITS.urlMaxLength || !MCP_FORM_PATTERNS.url.test(url))
    return [
      {
        field: 'mcp-url',
        message: '地址需为 https:// 或 loopback 的 http:// URL，且不含空格。',
      },
    ]
  return []
}

function stdioIssues(executable: string, argsText: string): McpFormFieldIssue[] {
  const issues: McpFormFieldIssue[] = []
  if (executable && !MCP_FORM_PATTERNS.executable.test(executable))
    issues.push({
      field: 'mcp-executable',
      message: '可执行文件不能是 shell（sh/bash/zsh/fish/cmd/powershell/pwsh），裸名称不能含空格。',
    })
  const args = lines(argsText)
  if (args.length > MCP_FORM_LIMITS.argsMaxItems)
    issues.push({
      field: 'mcp-args',
      message: `参数最多 ${MCP_FORM_LIMITS.argsMaxItems} 个，每行一个。`,
    })
  const badIndex = args.findIndex(
    (arg) => arg.length > MCP_FORM_LIMITS.argMaxLength || !MCP_FORM_PATTERNS.arg.test(arg),
  )
  if (badIndex >= 0)
    issues.push({
      field: 'mcp-args',
      message: `第 ${badIndex + 1} 个参数不合法：不能是 -c 或 /c，也不能为空。`,
    })
  return issues
}
function secretIssues(secretKind: string, secretText: string): McpFormFieldIssue[] {
  if (secretKind === 'none') return []
  if (secretKind === 'stdio-env') {
    for (const [index, line] of lines(secretText).entries()) {
      const at = line.indexOf('=')
      const name = at < 1 ? '' : line.slice(0, at)
      const reference = line.slice(at + 1)
      if (!name || !MCP_FORM_PATTERNS.envName.test(name))
        return [
          {
            field: 'mcp-secret',
            message: `第 ${index + 1} 项环境变量名不合法：需大写字母开头（不能是 PATH/HOME 等保留名）。`,
          },
        ]
      if (!MCP_FORM_PATTERNS.secretRef.test(reference))
        return [
          {
            field: 'mcp-secret',
            message: `第 ${index + 1} 项需形如 TOKEN=secret://namespace/name。`,
          },
        ]
    }
    return []
  }
  if (secretText && !MCP_FORM_PATTERNS.secretRef.test(secretText))
    return [
      {
        field: 'mcp-secret',
        message: 'SecretRef 需形如 secret://namespace/name。',
      },
    ]
  return []
}

function toolIssues(toolsText: string): McpFormFieldIssue[] {
  const tools = lines(toolsText)
  if (tools.length > MCP_FORM_LIMITS.toolsMaxItems)
    return [
      {
        field: 'mcp-tools',
        message: `允许工具最多 ${MCP_FORM_LIMITS.toolsMaxItems} 个。`,
      },
    ]
  const badIndex = tools.findIndex(
    (tool) => tool.length > MCP_FORM_LIMITS.toolMaxLength || !MCP_FORM_PATTERNS.toolName.test(tool),
  )
  if (badIndex >= 0)
    return [
      {
        field: 'mcp-tools',
        message: `第 ${badIndex + 1} 个工具名不合法：需以字母开头，只能含字母、数字、下划线、点、连字符。`,
      },
    ]
  const duplicated = tools.find((tool, index) => tools.indexOf(tool) !== index)
  if (duplicated)
    return [
      {
        field: 'mcp-tools',
        message: `允许工具中有重复项：「${duplicated}」。`,
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
): McpFormFieldIssue[] {
  const issues: McpFormFieldIssue[] = []
  if (!snapshot.serverId) {
    if (options.requireFilled) issues.push({ field: 'mcp-id', message: '请填写服务 ID。' })
  } else if (!MCP_FORM_PATTERNS.serverId.test(snapshot.serverId)) {
    issues.push({
      field: 'mcp-id',
      message: '服务 ID 需以小写字母开头，只能含小写字母、数字、点、下划线、连字符。',
    })
  }
  if (snapshot.transport === 'stdio') {
    if (!snapshot.executable) {
      if (options.requireFilled) issues.push({ field: 'mcp-executable', message: '请填写可执行文件。' })
    }
    issues.push(...stdioIssues(snapshot.executable, snapshot.argsText))
  } else if (snapshot.transport === 'http' || snapshot.transport === 'sse') {
    if (!snapshot.url) {
      if (options.requireFilled)
        issues.push({
          field: 'mcp-url',
          message: '请填写 HTTPS 地址，或本地策略允许的 loopback HTTP 地址。',
        })
    } else issues.push(...urlIssues(snapshot.url))
  }
  if (!snapshot.secretText && snapshot.secretKind !== 'none' && options.requireFilled)
    issues.push({ field: 'mcp-secret', message: '请填写 SecretRef。' })
  else issues.push(...secretIssues(snapshot.secretKind, snapshot.secretText))
  issues.push(...toolIssues(snapshot.toolsText))
  return issues
}
