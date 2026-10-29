import { createMcpPreset } from '@agnes/resource-control-contracts/mcp-presets'
import { describe, expect, it } from 'vitest'
import { deriveMcpName, formatMcpCommand, parseMcpCommand } from '../src/mcp-command.js'
import { MCP_FORM_LIMITS, type McpFormFieldSnapshot, mcpFormIssues } from '../src/mcp-form-validation.js'
import { localScriptWorkspace, workspaceContains } from '../src/mcp-workspace.js'

const base: McpFormFieldSnapshot = {
  transport: 'stdio',
  secretKind: 'none',
  serverId: 'demo',
  executable: 'npx',
  argsText: '',
  url: '',
  secretText: '',
  toolsText: '',
}
const live = { requireFilled: false }
const submit = { requireFilled: true }
const http = (url: string): McpFormFieldSnapshot => ({
  ...base,
  transport: 'http',
  executable: '',
  url,
})
const messages = (snapshot: McpFormFieldSnapshot, mode = live): string[] =>
  mcpFormIssues(snapshot, mode).map((issue) => issue.message)

describe('MCP form live validation mirrors the runtime schema', () => {
  it('passes the documented examples through every field', () => {
    const tokens = ['npx', '-y', '--mode test', 'C:\\tools\\server.exe', '']
    expect(parseMcpCommand(formatMcpCommand(tokens))).toEqual(tokens)
    expect(parseMcpCommand('npx -y "--mode test"')).toEqual(['npx', '-y', '--mode test'])
    expect(() => parseMcpCommand('npx "unterminated')).toThrow('Unclosed quote')
    const preset = createMcpPreset('playwright')
    if (preset.transport.kind !== 'stdio') throw new Error('expected stdio preset')
    expect(
      messages(
        {
          ...base,
          serverId: preset.serverId,
          executable: preset.transport.executable,
          argsText: preset.transport.args.join('\n'),
        },
        submit,
      ),
    ).toEqual([])
    expect(
      messages({
        ...http('https://example.com/mcp'),
        toolsText: 'fetch\nget-page',
      }),
    ).toEqual([])
    expect(
      messages({
        ...base,
        argsText: '-y\n--mode test',
        secretKind: 'stdio-env',
        secretText: 'TOKEN=secret://namespace/name',
      }),
    ).toEqual([])
  })

  it('rejects uppercase, leading-digit or oversized server IDs', () => {
    expect(messages({ ...base, serverId: 'Demo' })).toHaveLength(1)
    expect(messages({ ...base, serverId: '1demo' })).toHaveLength(1)
    expect(messages({ ...base, serverId: 'a'.repeat(128) })).toEqual([])
    expect(messages({ ...base, serverId: 'a'.repeat(129) })).toHaveLength(1)
  })

  it('rejects shells and whitespace-only names as executables, paths stay allowed', () => {
    expect(messages({ ...base, executable: 'bash' })).toHaveLength(1)
    expect(messages({ ...base, executable: 'POWERSHELL.EXE' })).toHaveLength(1)
    expect(messages({ ...base, executable: 'C:\\tools\\mcp-github.exe' })).toEqual([])
    expect(messages({ ...base, executable: '/usr/local/bin/mcp-github' })).toEqual([])
  })

  it('rejects shell runner arguments and honors the schema item cap', () => {
    expect(messages({ ...base, argsText: '-c' })).toHaveLength(1)
    expect(messages({ ...base, argsText: '/c' })).toHaveLength(1)
    expect(
      messages({
        ...base,
        argsText: Array.from({ length: MCP_FORM_LIMITS.argsMaxItems + 1 }, (_, i) => `a${i}`).join('\n'),
      }),
    ).toHaveLength(1)
  })

  it('rejects tool names that do not start with a letter, duplicates and overflow', () => {
    expect(messages({ ...base, toolsText: '1' })).toHaveLength(1)
    expect(messages({ ...base, toolsText: 'fetch\nfetch' })).toHaveLength(1)
    expect(
      messages({
        ...base,
        toolsText: Array.from({ length: MCP_FORM_LIMITS.toolsMaxItems + 1 }, (_, i) => `t${i}`).join('\n'),
      }),
    ).toHaveLength(1)
    expect(messages({ ...base, toolsText: 'a'.repeat(128) })).toEqual([])
    expect(messages({ ...base, toolsText: 'a'.repeat(129) })).toHaveLength(1)
  })

  it('rejects credential material in URLs without banning loopback http', () => {
    expect(messages(http('http://localhost:3000/mcp'))).toEqual([])
    expect(messages(http('http://127.0.0.1:3000/mcp'))).toEqual([])
    expect(messages(http('https://user@example.com/mcp'))).toHaveLength(1)
    expect(messages(http('https://example.com/mcp#frag'))).toHaveLength(1)
    expect(messages(http('https://example.com/mcp?token=x'))).toHaveLength(1)
    expect(messages(http('https://example.com/mcp?api_key=x'))).toHaveLength(1)
    expect(messages(http('https://example.com/mcp?api-key=x'))).toHaveLength(1)
    expect(messages(http('notaurl'))).toHaveLength(1)
  })

  it('checks each stdio-env line as NAME=secret:// and bearer/header refs as plain SecretRef', () => {
    expect(messages({ ...base, secretKind: 'stdio-env', secretText: 'token=secret://a/b' })).toHaveLength(1)
    expect(messages({ ...base, secretKind: 'stdio-env', secretText: 'PATH=secret://a/b' })).toHaveLength(1)
    expect(messages({ ...base, secretKind: 'stdio-env', secretText: 'TOKEN=https://a/b' })).toHaveLength(1)
    expect(messages({ ...base, secretKind: 'http-bearer', secretText: 'secret://a/b' })).toEqual([])
    expect(messages({ ...base, secretKind: 'http-bearer', secretText: 'secret://A/b' })).toHaveLength(1)
    expect(
      messages({ ...base, transport: 'http', url: 'https://example.com/mcp', secretKind: 'none' }),
    ).toEqual([])
  })

  it('only demands required fills at submit time, not while typing', () => {
    const empty: McpFormFieldSnapshot = { ...base, serverId: '', executable: '', toolsText: '' }
    expect(messages(empty, live)).toEqual([])
    expect(messages(empty, submit).join('\n')).toContain('Enter a service ID')
    expect(messages(empty, submit).join('\n')).toContain('Enter an executable')
    expect(messages({ ...http(''), toolsText: '' }, submit).join('\n')).toContain('HTTPS')
    expect(messages({ ...http(''), secretKind: 'http-bearer', secretText: '' }, submit).join('\n')).toContain(
      'credential reference',
    )
  })

  it.each([
    ['node', '/srv/mcp/node_modules/@vendor/server/dist/index.js', '/srv/mcp'],
    ['/usr/local/bin/node', '/srv/mcp/server.mjs', '/srv/mcp'],
    ['python3', '/srv/mcp/server.py', '/srv/mcp'],
    ['python3.12', '/srv/mcp/server.py', '/srv/mcp'],
    ['C:\\Program Files\\nodejs\\node.exe', 'C:\\MCP Tools\\node_modules\\server\\index.js', 'C:\\MCP Tools'],
  ])('requires a reviewed directory for the local script %s %s', (executable, argsText, directory) => {
    const script = { ...base, executable, argsText, sandboxProfile: 'network' }
    expect(localScriptWorkspace(executable, argsText)).toBe(directory)
    expect(messages(script, live)).toEqual([])
    expect(mcpFormIssues(script, submit)).toContainEqual({
      field: 'mcp-workspace',
      message: expect.stringContaining('local script and its dependencies'),
    })
    expect(messages({ ...script, workspacePath: directory }, submit)).toEqual([])
    expect(messages({ ...script, workspacePath: 'relative/folder' }, submit)).toContainEqual(
      expect.stringContaining('absolute'),
    )
    expect(messages({ ...script, sandboxProfile: 'off-with-warning' }, submit)).toEqual([])
    expect(workspaceContains(directory, directory)).toBe(true)
    expect(workspaceContains(`${directory}-other`, directory)).toBe(false)
  })

  it('keeps package launchers, inline code, remote services and explicit path aliases usable', () => {
    for (const [executable, argsText] of [
      ['npx', '-y\nfixture-mcp'],
      ['node', '-e\nconsole.log(1)'],
      ['python3', '-m\nfixture_server'],
    ] as const)
      expect(messages({ ...base, executable, argsText }, submit)).toEqual([])
    expect(
      messages({ ...http('https://example.com/mcp'), workspacePath: 'ignored/for/http' }, submit),
    ).toEqual([])
    // The browser cannot resolve aliases on a remote daemon. An explicit directory remains reviewable.
    expect(
      messages(
        { ...base, executable: 'node', argsText: '/private/tmp/mcp/server.js', workspacePath: '/tmp/mcp' },
        submit,
      ),
    ).toEqual([])
    expect(workspaceContains('/srv/mcp/./', '/srv/mcp/sub/../')).toBe(true)
    expect(workspaceContains('c:\\MCP Tools', 'C:\\mcp tools\\sub')).toBe(true)
  })
})

describe('MCP wizard reads the name from what was pasted', () => {
  it.each([
    ['npx --yes @playwright/mcp@0.0.83 --headless', 'playwright'],
    ['npx -y @modelcontextprotocol/server-github', 'github'],
    ['uvx mcp-server-sqlite --db-path "/tmp/a b.db"', 'sqlite'],
    ['pnpm dlx jira-mcp@1.2.3', 'jira'],
    ['/usr/local/bin/notes-server.py --stdio', 'notes'],
    ['node', 'node'],
    ['npx "unterminated', ''],
    ['', ''],
  ])('local command %s -> %s', (command, name) => {
    expect(deriveMcpName('stdio', command)).toBe(name)
  })

  it.each([
    ['https://mcp.example.com/mcp', 'example'],
    ['https://api.githubcopilot.com/mcp/', 'githubcopilot'],
    ['http://localhost:8080/sse', 'localhost'],
    ['http://127.0.0.1:3000/mcp', '127-0-0-1'],
    ['not a url', ''],
  ])('remote address %s -> %s', (url, name) => {
    expect(deriveMcpName('remote', url)).toBe(name)
  })
})

describe('an OAuth sign-in needs no saved secret', () => {
  it('accepts a remote server whose credential is an OAuth sign-in, with or without a client ID', () => {
    const remote = { ...http('https://mcp.example.com/mcp'), secretKind: 'oauth' }
    expect(messages(remote, submit)).toEqual([])
    expect(messages({ ...remote, secretText: 'client-123' }, submit)).toEqual([])
  })
})
