import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const workflow = readFileSync(
  new URL('../../.github/workflows/ci-platform-check.yml', import.meta.url),
  'utf8',
)
const steps = new Map(
  workflow
    .split('      - name: ')
    .slice(1)
    .map((body) => [body.split('\n')[0], body]),
)
function selected(name: string, os: string, shard: string, event: string) {
  const body = steps.get(name)
  expect(body, name).toBeDefined()
  let condition = /^ {8}if: (.+)$/m.exec(body ?? '')?.[1] ?? 'true'
  condition = condition.replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace('!cancelled()', 'true')
  const values: Record<string, string> = {
    'runner.os': os,
    'matrix.shard': shard,
    'github.event_name': event,
    'steps.suite.outcome': os === 'Linux' ? 'skipped' : 'success',
  }
  condition = condition.replace(/([\w.]+)\s*(==|!=)\s*'([^']*)'/g, (_, key, operator, value) =>
    String(operator === '==' ? values[key] === value : values[key] !== value),
  )
  const tokens = condition.match(/true|false|&&|\|\||[()]/g) ?? []
  expect(tokens.join('')).toBe(condition.replace(/\s/g, ''))
  let index = 0
  const atom = (): boolean => {
    const token = tokens[index++]
    if (token !== '(') return token === 'true'
    const value = or()
    expect(tokens[index++]).toBe(')')
    return value
  }
  const and = (): boolean => {
    let value = atom()
    while (tokens[index] === '&&') {
      index++
      const right = atom()
      value = value && right
    }
    return value
  }
  const or = (): boolean => {
    let value = and()
    while (tokens[index] === '||') {
      index++
      const right = and()
      value = value || right
    }
    return value
  }
  const result = or()
  expect(index).toBe(tokens.length)
  return result
}
function callerShards(os: string): string[] {
  const callers = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const platforms: Record<string, string> = { Linux: 'linux', macOS: 'macos', Windows: 'windows' }
  const platform = platforms[os]
  const job = callers.split(`\n  check-${platform}:\n`)[1]?.split(/\n {2}[a-z][a-z0-9-]*:\n/)[0] ?? ''
  const configured = /^ {6}shards: '([^']+)'$/m.exec(job)?.[1]
  if (!configured) throw new Error(`Missing check matrix for ${os}`)
  const shards = JSON.parse(configured) as string[]
  expect(shards).toEqual(os === 'Linux' ? [''] : Array.from({ length: 6 }, (_, i) => `${i + 1}/6`))
  return shards
}
const owners = [
  ['Windows PowerShell private scripts on pull requests', 'Windows', '1/6', true],
  ['macOS registry processes on pull requests', 'macOS', '1/6', true],
  ['Windows registry processes on pull requests', 'Windows', '1/6', true],
  ['Windows Skill install requests', 'Windows', '2/6', false],
  ['Windows daemon startup directories', 'Windows', '1/6', false],
  ['Windows conversation MCP registration', 'Windows', '2/6', false],
  ['Windows native compiler environment', 'Windows', '6/6', false],
  ['Windows portable native runtime', 'Windows', '6/6', false],
  ['verify local delivery with Windows PowerShell 5.1', 'Windows', '1/6', false],
  ['verify local delivery with PowerShell 7', 'Windows', '1/6', false],
] as const
it('keeps every isolated check on exactly one of six platform shards', () => {
  for (const event of ['pull_request', 'push', 'schedule', 'workflow_dispatch'])
    for (const os of ['Linux', 'macOS', 'Windows']) {
      const shards = callerShards(os)
      for (const [name, owner, shard, prOnly] of owners)
        expect(
          shards.filter((part) => selected(name, os, part, event)),
          `${event}/${os}/${name}`,
        ).toEqual(os === owner && (!prOnly || event === 'pull_request') ? [shard] : [])
      for (const name of [
        'startup budget (shared-runner diagnostic)',
        'Download prepared local acceptance package',
        'Restore prepared local acceptance package',
        'verify packaged directory publication capability',
      ])
        expect(
          shards.filter((part) => selected(name, os, part, event)),
          `${event}/${os}/${name}`,
        ).toEqual([os === 'Linux' ? '' : '1/6'])
    }
})
it('runs story once on Linux with actual sandbox and shell prerequisites', () => {
  expect(workflow.match(/run: pnpm test:story/g)).toHaveLength(1)
  for (const os of ['Linux', 'macOS', 'Windows'])
    expect(
      selected(
        'Story regressions (zero retries, no selected skips)',
        os,
        os === 'Linux' ? '' : '1/6',
        'pull_request',
      ),
    ).toBe(os === 'Linux')
  const sandbox = steps.get('Linux sandbox and shells') ?? ''
  expect(sandbox).toContain("if: runner.os == 'Linux'")
  expect(sandbox).toContain('sudo apt-get update && sudo apt-get install -y bubblewrap zsh')
  expect(sandbox).toContain('bash tools/e2e-web/provision-linux-sandbox.sh')
  expect(workflow.indexOf('Linux sandbox and shells')).toBeLessThan(workflow.indexOf('run: pnpm test:story'))
})

it('runs fresh Windows native compilation only in its isolated owner step', () => {
  const fast = steps.get('test fast tier (includes Protocol conformance)') ?? ''
  const held = /AGNES_TEST_EXCLUDE:.*runner\.os == 'Windows' && '([^']+)'/.exec(fast)?.[1].split(',') ?? []
  expect(held).toContain('packages/cli/test/windows-runtime.test.ts')
  const compiler = steps.get('Windows native compiler environment') ?? ''
  expect(compiler).toContain('prepare-windows-msvc.ps1')
  const runtime = steps.get('Windows portable native runtime') ?? ''
  expect(runtime).toContain('pnpm exec vitest run packages/cli/test/windows-runtime.test.ts --maxWorkers=1')
  expect(runtime).not.toContain('--shard=')
  expect(workflow.indexOf('Windows native compiler environment')).toBeGreaterThan(
    workflow.indexOf('run: pnpm exec vitest run --project fast'),
  )
  expect(workflow.indexOf('Windows portable native runtime')).toBeLessThan(
    workflow.indexOf('Restore prepared local acceptance package'),
  )
})
