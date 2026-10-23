import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { initializeHome } from '@agnes/host'
import { demoProvider } from '@agnes/package-manager'
import { expect, it } from 'vitest'

// This gate deliberately consumes the real release output. Build @agnes/cli build:local first.
const cli = fileURLToPath(new URL('../dist/local/agnes.mjs', import.meta.url))
const execute = promisify(execFile)
it('keeps official extensions and privileged CU tools in the built distribution', async () => {
  expect(existsSync(cli), 'run @agnes/cli build:local before this gate').toBe(true)
  const parent = join(tmpdir(), 'agh-real-eval')
  mkdirSync(parent, { recursive: true })
  const home = mkdtempSync(join(parent, 'built-host-grants-'))
  initializeHome(home)
  const profileDir = join(home, 'profiles/local-dev')
  mkdirSync(profileDir, { recursive: true })
  const provider = demoProvider()
  const model = provider.routes[0]?.models?.[0]
  if (!model) throw new Error('demo model missing')
  model.input = ['text', 'image']
  writeFileSync(
    join(profileDir, 'profile.yaml'),
    JSON.stringify({
      name: 'local-dev',
      provider,
      extensionIsolation: { extensions: { 'agnes/hooks-runner': 'preferred' } },
    }),
  )
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('AGNES_') && !key.startsWith('VITEST_') && key !== 'NODE_OPTIONS',
    ),
  )
  env.AGH_HOME = home
  const runText = async (args: string[]) => {
    const pending = execute(process.execPath, [cli, ...args, '--standalone'], {
      cwd: home,
      env,
      timeout: 30_000,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
    })
    pending.child.stdin?.end()
    return (await pending).stdout
  }
  const run = async (args: string[]) => JSON.parse(await runText(args))
  try {
    const report = await run(['doctor', 'extensions', '--json'])
    const extensions = report.find((section: { name: string }) => section.name === 'extensions')
    expect(extensions.status, JSON.stringify(report)).toBe('ok')
    const rows = extensions.detail.map((line: string) => JSON.parse(line))
    for (const id of [
      'agnes/computer-use',
      'agnes/hooks-runner',
      'agnes/mcp-search',
      'agnes/privacy',
      'agnes/tools-web',
      'agnes/follow-up-hint',
    ]) {
      expect(rows, id).toContainEqual(expect.objectContaining({ id, loaded: true, trust: 'builtin' }))
    }
    const audit = readFileSync(join(home, 'data/audit/host.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(
      audit.some(
        (event) =>
          event.detail?.id === 'agnes/hooks-runner' &&
          (event.kind === 'extension.isolated' ||
            (event.kind === 'extension.isolation-fallback' && event.detail.reason === 'backend-unavailable')),
      ),
    ).toBe(true)
    const tools = await run(['tools', '--permission', 'full-access', '--json'])
    console.info(
      'BUILT_HOST_GRANTS',
      JSON.stringify({
        extensions: rows.map((row: { id: string }) => row.id),
        tools: tools.tools.map((tool: { name: string }) => tool.name),
      }),
    )
    expect(tools.tools).toContainEqual(expect.objectContaining({ name: 'tool_search' }))
    // guards-allow-platform: CU tool exposure is supported on macOS; other hosts retain the remaining grant checks.
    if (process.platform === 'darwin')
      expect(tools.tools).toContainEqual(expect.objectContaining({ name: 'computer_use' }))
    const result = await runText(['-p', 'call tool_search {"query":"skill remembering"}'])
    expect(result).toContain('Skill remembering')
    expect(result).toContain('Call skill_read with this exact name')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 90_000)
