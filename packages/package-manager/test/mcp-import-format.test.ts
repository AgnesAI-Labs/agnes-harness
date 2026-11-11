import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readMcpImport } from '../src/index.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function source() {
  const root = await mkdtemp(join(tmpdir(), 'agh-mcp-format-'))
  roots.push(root)
  return root
}

it('normalizes equivalent client declarations and locates optional Skills without scanning the repository', async () => {
  const root = await source(),
    target = join(root, 'installed')
  await mkdir(join(root, '.codex-plugin'))
  await mkdir(join(root, '.claude-plugin'))
  await mkdir(join(root, '.agents/skills/example'), { recursive: true })
  await writeFile(
    join(root, '.agents/skills/example/SKILL.md'),
    '---\nname: example\ndescription: Example\n---\nInstructions',
  )
  await writeFile(
    join(root, '.codex-plugin/mcp.json'),
    JSON.stringify({
      mcpServers: { sample: { command: 'node', args: ['./server.mjs'], cwd: '.', startup_timeout_sec: 30 } },
    }),
  )
  await writeFile(
    join(root, '.claude-plugin/plugin.json'),
    JSON.stringify({
      name: 'sample',
      mcpServers: { sample: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs'] } },
    }),
  )
  const result = await readMcpImport(root, target)
  expect(result).toMatchObject({
    skills: ['.agents/skills/example'],
    configurationFiles: ['.codex-plugin/mcp.json', '.claude-plugin/plugin.json'],
    warnings: ['MCP_HOST_TIMEOUT_APPLIES'],
    definitions: [
      {
        serverId: 'sample',
        transport: { kind: 'stdio', executable: 'node', args: [join(target, 'server.mjs')] },
        workspacePath: target,
        secretBinding: { kind: 'none' },
      },
    ],
  })
  await writeFile(
    join(root, '.codex-plugin/mcp.json'),
    JSON.stringify({ mcpServers: { sample: { command: 'node', args: ['./different.mjs'] } } }),
  )
  await expect(readMcpImport(root, target)).resolves.toMatchObject({
    definitions: [],
    skills: ['.agents/skills/example'],
    warnings: ['MCP_OPTIONAL_CONFIG_UNSUPPORTED'],
  })
})

it.each([
  { command: 'bash', args: ['./install.sh'] },
  { command: 'node', args: ['../escape.mjs'] },
  { command: 'node', args: ['${UNKNOWN_ROOT}/script.mjs'] },
  {
    command: 'node',
    args: ['./main.mjs'],
    env: Object.fromEntries([['API_KEY', ['synthetic', 'value'].join('-')]]),
  },
  {
    type: 'http',
    url: (() => {
      const value = new URL('https://example.test/mcp')
      value.searchParams.set('token', 'synthetic')
      return value.href
    })(),
  },
  { type: 'http', url: 'https://example.test/mcp', unexpected: true },
])('refuses unsupported or unsafe configurations without echoing their values (%j)', async (entry) => {
  const root = await source()
  await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { sample: entry } }))
  await expect(readMcpImport(root, join(root, 'install'))).rejects.toMatchObject({
    code: expect.stringMatching(/^MCP_/),
    message: expect.not.stringContaining('literal-private-value'),
  })
})

it('binds credential placeholders through existing references without accepting literal secrets', async () => {
  const root = await source()
  await writeFile(
    join(root, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        remote: { type: 'sse', url: 'https://example.test/sse', headers: { 'x-api-key': '${API_KEY}' } },
      },
    }),
  )
  expect((await readMcpImport(root, join(root, 'install')))?.requiredCredentials).toEqual([
    'remote.header.x-api-key',
  ])
  expect(
    (await readMcpImport(root, join(root, 'install'), { 'remote.header.x-api-key': 'secret://test/sample' }))
      ?.definitions[0],
  ).toMatchObject({
    transport: { kind: 'sse' },
    secretBinding: { kind: 'http-header', headerName: 'x-api-key', credentialRef: 'secret://test/sample' },
  })
})
