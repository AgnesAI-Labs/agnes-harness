import type { McpServerDefinitionInput, McpServerDescriptor } from '@agnes/protocol'
import { type LocaleTranslator, setDisclosureOpen } from '@agnes/web-ui'
import { $ } from './admin-dom.js'
import type { ResourceAdminApi } from './api.js'
import { parseMcpCommand } from './mcp-command.js'
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
    ['mcp-token-env', 'input'],
    ['mcp-workspace', 'input'],
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
      workspacePath: $('mcp-workspace', 'input').value.trim(),
      sandboxProfile: $('mcp-sandbox', 'select').value,
    }
  }
  /**
   * Immediate field validation: patterns and limits come from backend schema (mcp-form-validation.ts),
   * marking issues such as invalid tool names at the field while typing, instead of a generic 400 invalid
   * resource-management parameters response on submit. During input (requireFilled=false) check only
   * nonempty values; before submission (true) also flag required-but-empty fields.
   */
  function syncMcpFieldFeedback(
    requireFilled = false,
    t: LocaleTranslator = input.text(),
  ): ReturnType<typeof mcpFormIssues> {
    const snapshot = mcpFormSnapshot()
    const credential = document.getElementById('mcp-credential') as HTMLSelectElement | null
    const mapped =
      snapshot.transport === 'stdio' &&
      credential?.value &&
      snapshot.secretText === `${$('mcp-token-env', 'input').value}=${credential.value}`
    const issues = mcpFormIssues(snapshot, { requireFilled }, t).map((issue) =>
      mapped && issue.field === 'mcp-secret' ? { ...issue, field: 'mcp-token-env' as const } : issue,
    )
    for (const [id, tag] of MCP_FIELD_CONTROLS) $(id, tag).removeAttribute('aria-invalid')
    for (const issue of issues) {
      const control = MCP_FIELD_CONTROLS.find(([fieldId]) => fieldId === issue.field)
      if (control) $(control[0], control[1]).setAttribute('aria-invalid', 'true')
    }
    $('mcp-error', 'p').textContent = issues[0]?.message ?? ''
    const command = document.getElementById('mcp-command')
    if (command) {
      const commandIssue = issues.some(
        (issue) => issue.field === 'mcp-executable' || issue.field === 'mcp-args',
      )
      if (commandIssue) {
        command.setAttribute('aria-invalid', 'true')
        command.setAttribute('aria-describedby', 'mcp-error')
      } else {
        command.removeAttribute('aria-invalid')
        command.removeAttribute('aria-describedby')
      }
    }
    if (requireFilled && issues[0]) {
      const field = issues[0].field
      if (command && (field === 'mcp-executable' || field === 'mcp-args')) command.focus()
      else {
        const advanced = document.getElementById('mcp-advanced')
        if (advanced && document.getElementById(field)?.closest('#mcp-advanced'))
          setDisclosureOpen(advanced, true)
        document.getElementById(field)?.focus()
      }
    }
    return issues
  }
  function definitionFromForm(t: LocaleTranslator = input.text()): McpServerDefinitionInput {
    const serverId = $('mcp-id', 'input').value.trim()
    const displayName = $('mcp-name', 'input').value.trim()
    const command = document.getElementById('mcp-command') as HTMLInputElement | null
    const args =
      command && mcpTransport.value === 'stdio'
        ? parseMcpCommand(command.value).slice(1)
        : $('mcp-args', 'textarea')
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
    if (secretKind !== 'none' && secretKind !== 'oauth' && !secret)
      throw new McpFormValidationError(t('error.form.secret'))
    const secretBinding =
      secretKind === 'none'
        ? { kind: 'none' as const }
        : secretKind === 'oauth'
          ? // Sign-in happens after saving; an existing client ID is optional.
            { kind: 'oauth' as const, ...(secret ? { staticClientId: secret } : {}) }
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
    // The mcp-transport select option set lives in the workbench's MCP dialog scaffold, a
    // different package than this dispatch -- nothing guarantees they stay in sync. Fail loudly on an
    // unrecognized value instead of silently falling through to an SSE-shaped definition.
    throw new Error(t('error.invalid-transport', { value: mcpTransport.value }))
  }

  return { syncMcpFieldFeedback, definitionFromForm }
}

type ToolDisclosure = NonNullable<McpServerDefinitionInput['toolDisclosure']>

/** The edit form has no tool-loading field: an edit keeps the mode set on the detail page. */
export function keepToolDisclosure(
  definition: McpServerDefinitionInput,
  editing: McpServerDescriptor | undefined,
): McpServerDefinitionInput {
  const kept = editing?.definition.toolDisclosure
  return kept ? { ...definition, toolDisclosure: kept } : definition
}

/**
 * Saves a server's tool loading mode. A low-risk, reversible preference: saved at once, with no
 * confirmation step. The store keeps the server's trust and enablement because nothing that runs or
 * connects changes; a failure lands in the page notice like any other action.
 */
export async function saveToolDisclosure(
  page: Readonly<{
    api(): Pick<ResourceAdminApi, 'mcpUpdate'>
    track(receipt: { operationId: string }): Promise<boolean>
    showError(error: unknown): void
    render(): void
  }>,
  server: McpServerDescriptor,
  toolDisclosure: ToolDisclosure,
): Promise<void> {
  try {
    const definition = { ...server.definition, toolDisclosure } as McpServerDefinitionInput
    await page.track(await page.api().mcpUpdate(server.serverId, server.revision, definition))
  } catch (error) {
    page.showError(error)
    page.render()
  }
}

/** A stdio definition's sandbox profile; one without a profile runs `strict`. */
export function sandboxProfileOf(definition: McpServerDefinitionInput): string {
  return ('sandboxProfile' in definition ? definition.sandboxProfile : undefined) ?? 'strict'
}
