import { describe, expect, it } from 'vitest'
import { MCP_FORM_LIMITS, type McpFormFieldSnapshot, mcpFormIssues } from '../src/mcp-form-validation.js'

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
    expect(messages(empty, submit).join('\n')).toContain('服务 ID')
    expect(messages(empty, submit).join('\n')).toContain('可执行文件')
    expect(messages({ ...http(''), toolsText: '' }, submit).join('\n')).toContain('HTTPS')
    expect(messages({ ...http(''), secretKind: 'http-bearer', secretText: '' }, submit).join('\n')).toContain(
      'SecretRef',
    )
  })
})
