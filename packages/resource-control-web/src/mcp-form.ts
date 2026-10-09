import type { McpServerDefinitionInput } from '@agnes/protocol'
import type { LocaleTranslator } from '@agnes/web-ui'
import { $ } from './admin-dom.js'
import { type McpFormFieldId, type McpFormFieldSnapshot, mcpFormIssues } from './mcp-form-validation.js'

export class McpFormValidationError extends Error {}

export function createMcpForm(input: {
  transport: HTMLSelectElement
  secretKind: HTMLSelectElement
  text: () => LocaleTranslator
}) {
  const mcpTransport = input.transport
  const mcpSecretKind = input.secretKind
  const MCP_FIELD_CONTROLS: ReadonlyArray<readonly [McpFormFieldId, 'input' | 'textarea']> = [
    ['mcp-id', 'input'],
    ['mcp-executable', 'input'],
    ['mcp-args', 'textarea'],
    ['mcp-url', 'input'],
    ['mcp-secret', 'textarea'],
    ['mcp-tools', 'textarea'],
  ]
  function mcpFormSnapshot(): McpFormFieldSnapshot {
    return {
      transport: mcpTransport.value,
      secretKind: mcpSecretKind.value,
      serverId: $('mcp-id', 'input').value.trim(),
      executable: $('mcp-executable', 'input').value.trim(),
      argsText: $('mcp-args', 'textarea').value,
      url: $('mcp-url', 'input').value.trim(),
      secretText: $('mcp-secret', 'textarea').value.trim(),
      toolsText: $('mcp-tools', 'textarea').value,
    }
  }
  /**
   * 即时字段校验：正则与上限直接来自后台 schema（mcp-form-validation.ts），在输入阶段就把
   * 「工具名不合法」这类问题按字段标红提示，而不是等提交后收到笼统的 400「资源管理参数无效」。
   * 输入过程（requireFilled=false）只看非空值，不在用户还没填到时催促；提交前（true）把
   * 「必填但为空」也标出来。
   */
  function syncMcpFieldFeedback(
    requireFilled = false,
    t: LocaleTranslator = input.text(),
  ): ReturnType<typeof mcpFormIssues> {
    const issues = mcpFormIssues(mcpFormSnapshot(), { requireFilled }, t)
    for (const [id, tag] of MCP_FIELD_CONTROLS) $(id, tag).removeAttribute('aria-invalid')
    for (const issue of issues) {
      const control = MCP_FIELD_CONTROLS.find(([fieldId]) => fieldId === issue.field)
      if (control) $(control[0], control[1]).setAttribute('aria-invalid', 'true')
    }
    $('mcp-error', 'p').textContent = issues[0]?.message ?? ''
    return issues
  }
  function definitionFromForm(t: LocaleTranslator = input.text()): McpServerDefinitionInput {
    const serverId = $('mcp-id', 'input').value.trim()
    const displayName = $('mcp-name', 'input').value.trim()
    const args = $('mcp-args', 'textarea')
      .value.split('\n')
      .map((value) => value.trim())
      .filter(Boolean)
    const allow = $('mcp-tools', 'textarea')
      .value.split('\n')
      .map((value) => value.trim())
      .filter(Boolean)
    const secretKind = mcpSecretKind.value
    const secret = $('mcp-secret', 'textarea').value.trim()
    if (!serverId || !displayName) throw new McpFormValidationError(t('error.form.identity'))
    if (mcpTransport.value === 'stdio') {
      const executable = $('mcp-executable', 'input').value.trim()
      if (!executable) throw new McpFormValidationError(t('error.form.executable'))
      const secretBinding =
        secretKind === 'none'
          ? { kind: 'none' as const }
          : (() => {
              const env: Record<string, string> = {}
              for (const line of secret
                .split('\n')
                .map((value) => value.trim())
                .filter(Boolean)) {
                const at = line.indexOf('=')
                const name = line.slice(0, at)
                const reference = line.slice(at + 1)
                if (at < 1 || !reference || Object.hasOwn(env, name))
                  throw new McpFormValidationError(t('error.form.env-format'))
                env[name] = reference
              }
              if (!Object.keys(env).length) throw new McpFormValidationError(t('error.form.env-empty'))
              return { kind: 'stdio-env' as const, env }
            })()
      return {
        serverId,
        displayName,
        transport: { kind: 'stdio', executable, args },
        ...($('mcp-workspace', 'input').value.trim()
          ? { workspacePath: $('mcp-workspace', 'input').value.trim() }
          : {}),
        sandboxProfile: $('mcp-sandbox', 'select').value as
          | 'strict'
          | 'workspace-write'
          | 'network'
          | 'off-with-warning',
        secretBinding,
        ...(allow.length ? { toolPolicy: { allow } } : {}),
      }
    }
    const url = $('mcp-url', 'input').value.trim()
    if (!url) throw new McpFormValidationError(t('error.form.url'))
    if (secretKind !== 'none' && !secret) throw new McpFormValidationError(t('error.form.secret'))
    const secretBinding =
      secretKind === 'none'
        ? { kind: 'none' as const }
        : secretKind === 'http-bearer'
          ? { kind: 'http-bearer' as const, credentialRef: secret }
          : {
              kind: 'http-header' as const,
              headerName: $('mcp-header-name', 'select').value as 'x-api-key' | 'x-api-token',
              credentialRef: secret,
            }
    if (mcpTransport.value === 'http') {
      return {
        serverId,
        displayName,
        transport: { kind: 'http', url },
        secretBinding,
        ...(allow.length ? { toolPolicy: { allow } } : {}),
      }
    }
    if (mcpTransport.value === 'sse') {
      return {
        serverId,
        displayName,
        transport: { kind: 'sse', url },
        secretBinding,
        ...(allow.length ? { toolPolicy: { allow } } : {}),
      }
    }
    // The mcp-transport select option set lives in packages/web/public/resources.html, a
    // different package than this dispatch -- nothing guarantees they stay in sync. Fail loudly on an
    // unrecognized value instead of silently falling through to an SSE-shaped definition.
    throw new Error(t('error.invalid-transport', { value: mcpTransport.value }))
  }

  return { syncMcpFieldFeedback, definitionFromForm }
}
