import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { workspaceRoundtrip } from '../test/workspace-roundtrip.js'
import { createDockerSandboxProvider, probeDocker } from './index.js'

const dir = mkdtempSync(join(tmpdir(), 'agnes-docker-cli-'))
const calls = join(dir, 'calls.jsonl')
const preload = join(dir, 'cli.mjs')
beforeAll(() => {
  copyFileSync(process.execPath, join(dir, process.platform === 'win32' ? 'docker.exe' : 'docker'))
  writeFileSync(
    preload,
    `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
    import { basename, join } from 'node:path';
    const args = process.argv.slice(1);
    args[0] = basename(args[0] ?? '');
    appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
    if (args[0] === 'version') { process.stdout.write('27.0'); process.exit(0); }
    if (args[0] === 'info') {
      process.stdout.write(process.env.AGH_DOCKER_OS ?? 'linux');
      process.exit(Number(process.env.AGH_DOCKER_EXIT ?? 0));
    }
    if (args[0] === 'run' && process.env.AGH_DOCKER_MARKERS === '1') {
      const workspace = args[args.indexOf('-w') + 1];
      const marker = readFileSync(join(workspace, 'input-marker'), 'utf8');
      if (marker !== args.at(-1)) process.exit(42);
      writeFileSync(join(workspace, 'output-marker'), marker);
      process.stdout.write('ok\\n');
      process.exit(0);
    }
    process.stderr.write('container execution must not be attempted');
    process.exit(125);`,
  )
})
afterEach(() => vi.unstubAllEnvs())
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function cli(os: string, code = 0) {
  writeFileSync(calls, '')
  vi.stubEnv('PATH', `${dir}${delimiter}${process.env.PATH ?? ''}`)
  vi.stubEnv('NODE_OPTIONS', `--import=${pathToFileURL(preload).href}`)
  vi.stubEnv('AGH_DOCKER_OS', os)
  vi.stubEnv('AGH_DOCKER_EXIT', String(code))
}

describe('Docker Linux container capability probe', () => {
  it.each(['windows', '', 'unknown', 'linux\nwindows', `linux${' '.repeat(70)}`])(
    'refuses an unsupported or unproven daemon OS (%j) before container execution',
    async (os) => {
      cli(os)
      const provider = createDockerSandboxProvider()
      const capabilities = await provider.probe?.()
      expect(capabilities).toMatchObject({ available: false, network: false, fsWrite: [] })
      expect(capabilities?.unavailableReason).toContain('Linux container daemon')
      const instance = await provider.create({})
      await expect(instance.exec({ argv: ['echo', 'ok'], cwd: dir })).rejects.toMatchObject({
        code: 'SANDBOX_UNAVAILABLE',
      })
      const commands = readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(commands.every((args) => args[0] === 'info')).toBe(true)
    },
  )

  it('recognizes a proven Linux daemon without running a container in the probe', async () => {
    cli('linux\n')
    expect(await probeDocker()).toMatchObject({ available: true, network: true })
    expect(JSON.parse(readFileSync(calls, 'utf8'))).toEqual(['info', '--format', '{{.OSType}}'])
  })

  it('does not turn a failing daemon query into support even when stdout says linux', async () => {
    cli('linux', 13)
    expect(await probeDocker()).toMatchObject({ available: false, network: false, fsWrite: [] })
  })

  it.each([String.raw`D:\work\proj`, String.raw`\\server\share\proj`, '//server/share/proj'])(
    'refuses a host workspace requiring Linux container path mapping (%j)',
    async (workspaceRoot) => {
      cli('linux')
      const provider = createDockerSandboxProvider()
      const instance = await provider.create({ workspaceRoot })
      expect(instance.capabilities).toMatchObject({ available: false, network: false, fsWrite: [] })
      expect(instance.capabilities.unavailableReason).toContain('path mapping')
      await expect(instance.exec({ argv: ['echo', 'ok'], cwd: workspaceRoot })).rejects.toMatchObject({
        code: 'SANDBOX_UNAVAILABLE',
      })
    },
  )

  it.each([{ cwd: String.raw`D:\work\proj` }, { cwd: dir, fsWrite: [{ path: String.raw`D:\work\proj` }] }])(
    'refuses request paths that need container mapping before execution (%j)',
    async (paths) => {
      cli('linux')
      const instance = await createDockerSandboxProvider().create({})
      await expect(instance.exec({ argv: ['echo', 'ok'], ...paths })).rejects.toMatchObject({
        code: 'SANDBOX_UNAVAILABLE',
      })
      const commands = readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(commands.every((args) => args[0] === 'info')).toBe(true)
    },
  )

  it.each([true, false])(
    'sends the round-trip request and detects mismatched client input (%s)',
    async (matches) => {
      cli('linux')
      vi.stubEnv('AGH_DOCKER_MARKERS', '1')
      const workspace = mkdtempSync(join(dir, 'workspace-'))
      const roundtrip = workspaceRoundtrip(workspace)
      if (!matches) writeFileSync(join(workspace, 'input-marker'), 'different-workspace')
      const instance = await createDockerSandboxProvider().create({ workspaceRoot: workspace })
      if (!instance.capabilities.available) {
        expect(workspace).toMatch(/^[A-Za-z]:[\\/]|^[\\/]{2}/)
        expect(instance.capabilities.unavailableReason).toBe(
          'host path mapping to Linux containers is unavailable',
        )
        await expect(instance.exec(roundtrip.request)).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
        await instance.dispose()
        return
      }
      const result = await instance.exec(roundtrip.request)
      expect(result.code).toBe(matches ? 0 : 42)
      if (matches) expect(readFileSync(roundtrip.output, 'utf8')).toBe(roundtrip.nonce)
      else expect(existsSync(roundtrip.output)).toBe(false)
      const commands = readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      const run = commands.find((args) => args[0] === 'run')
      expect(run?.slice(0, 3)).toEqual(['run', '--rm', '--name'])
      expect(run?.slice(4)).toEqual([
        '--network',
        'none',
        '--mount',
        `type=bind,src=${workspace},dst=${workspace}`,
        '-w',
        workspace,
        'alpine:3.20',
        'sh',
        '-c',
        'test "$(cat input-marker)" = "$1" && printf "%s" "$1" > output-marker && echo ok',
        'agh-bind-check',
        roundtrip.nonce,
      ])
      await instance.dispose()
    },
  )
})
