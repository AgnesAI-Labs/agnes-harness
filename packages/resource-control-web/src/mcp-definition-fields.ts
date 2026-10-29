import type { McpServerDefinitionInput } from '@agnes/protocol'
import { $ } from './admin-dom.js'
import { sandboxProfileOf } from './mcp-form.js'

export function writeMcpDefinition(definition: McpServerDefinitionInput): void {
  $('mcp-workspace', 'input').value =
    ('workspacePath' in definition ? definition.workspacePath : undefined) ?? ''
  $('mcp-id', 'input').value = definition.serverId
  $('mcp-name', 'input').value = definition.displayName
  $('mcp-transport', 'select').value = definition.transport.kind
  $('mcp-sandbox', 'select').value = sandboxProfileOf(definition)
  $('mcp-executable', 'input').value =
    definition.transport.kind === 'stdio' ? definition.transport.executable : ''
  $('mcp-args', 'textarea').value =
    definition.transport.kind === 'stdio' ? definition.transport.args.join('\n') : ''
  $('mcp-url', 'input').value =
    definition.transport.kind === 'http' || definition.transport.kind === 'sse'
      ? definition.transport.url
      : ''
  $('mcp-secret-kind', 'select').value = definition.secretBinding.kind
  // OAuth carries an optional staticClientId instead of a credentialRef.
  $('mcp-secret', 'textarea').value =
    definition.secretBinding.kind === 'stdio-env'
      ? Object.entries(definition.secretBinding.env)
          .map(([name, reference]) => `${name}=${reference}`)
          .join('\n')
      : definition.secretBinding.kind === 'none'
        ? ''
        : definition.secretBinding.kind === 'oauth'
          ? (definition.secretBinding.staticClientId ?? '')
          : definition.secretBinding.credentialRef
  if (definition.secretBinding.kind === 'http-header')
    $('mcp-header-name', 'select').value = definition.secretBinding.headerName
  $('mcp-tools', 'textarea').value = definition.toolPolicy?.allow?.join('\n') ?? ''
}
