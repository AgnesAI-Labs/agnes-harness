import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashDirectory } from '@agnes/host'
import { describe, expect, it } from 'vitest'
import { windowsChildren, windowsIdentities } from './windows-processes.js'

const bin = process.env.AGNES_SEA_BIN
const harness = process.env.AGNES_SEA_LOADER_HARNESS

describe.skipIf(!bin || !harness)('SEA smoke', () => {
  it('runs production commands and loads a TypeScript extension through the SEA loader', async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'agnes-sea-'))
    const home = join(temporary, 'home')
    // Session workspaces cannot contain the private .agh state under home.
    const workspace = join(temporary, 'workspace')
    const server = spawn(
      process.env.AGNES_SEA_NODE || process.execPath,
      [fileURLToPath(new URL('./fixtures/openai-server.mjs', import.meta.url))],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    const env = { ...process.env, AGH_HOME: home, HOME: home }
    try {
      mkdirSync(workspace, { recursive: true })
      const profileDir = join(home, 'profiles', 'local-dev')
      const secrets = join(home, '.agh', 'secrets', 'test')
      if (process.platform === 'win32') {
        const distribution = dirname(resolve(bin as string))
        execFileSync(
          join(distribution, 'runtime', 'node.exe'),
          [
            '-e',
            `
          const api=require(${JSON.stringify(join(distribution, 'node_modules/@agnes/system-node/dist/native/agnes-system.node'))});
          const fs=require('node:fs');
          for(const path of ${JSON.stringify([home, join(home, 'profiles'), profileDir, join(home, '.agh'), join(home, '.agh', 'secrets'), secrets])}) api.createPrivateDirectory(path);
          const fd=api.createPrivateFile(${JSON.stringify(join(secrets, 'wire'))});
          try {fs.writeFileSync(fd,'sea-smoke-key')}finally{fs.closeSync(fd)};
        `,
          ],
          { encoding: 'utf8', env, windowsHide: true, timeout: 10000 },
        )
      } else {
        mkdirSync(profileDir, { recursive: true })
        mkdirSync(secrets, { recursive: true })
        writeFileSync(join(secrets, 'wire'), 'sea-smoke-key', { mode: 0o600 })
      }
      const port = await new Promise<string>((resolvePort, reject) => {
        server.once('error', reject)
        server.once('exit', (code) => reject(new Error(`loopback server exited before ready: ${code}`)))
        server.stdout.once('data', (chunk) => resolvePort(String(chunk).trim()))
      })
      const profile = readFileSync(new URL('./fixtures/faux-profile.yaml', import.meta.url), 'utf8')
      writeFileSync(
        join(profileDir, 'profile.yaml'),
        profile.replaceAll('SEA_BASE_URL', `http://127.0.0.1:${port}/v1`),
      )
      const packageDirectory = join(home, '.agh', 'profiles', 'local-dev', 'packages', 'test__hello')
      mkdirSync(packageDirectory, { recursive: true })
      cpSync(new URL('./fixtures/hello-ext/', import.meta.url), packageDirectory, { recursive: true })
      expect(existsSync(join(packageDirectory, 'agnes.extension.json')), 'copied extension manifest').toBe(
        true,
      )
      const timestamp = '2026-09-12T00:00:00.000Z'
      writeFileSync(
        join(profileDir, 'agnes-lock.json'),
        JSON.stringify({
          lockfileVersion: 1,
          profile: 'local-dev',
          resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
          generatedAt: timestamp,
          generatedBy: { agnesVersion: '0.0.0' },
          packages: {
            'test/hello': {
              version: '0.0.1',
              source: { type: 'file', ref: 'file:hello-ext' },
              integrity: hashDirectory(packageDirectory),
              trust: 'trusted',
              license: 'MIT',
              apiRange: '^1.0',
              // The SEA loader harness imports this fixture directly; Host requires an immutable
              // runtime snapshot before an external package can be enabled.
              state: { installed: timestamp, trusted: timestamp, enabled: false },
              dependencies: {},
              previous: null,
            },
          },
          provider: { package: '@agnes/ai', adapters: ['@agnes/ai'] },
          policySnapshot: {
            capabilityCeiling: [
              'tools',
              'hooks',
              'slots',
              'events',
              'resources',
              'network',
              'network.publicRead',
              'tools.invoke',
              'artifacts',
              'subagent',
            ],
            workspacePackages: 'require-project-trust',
          },
          seams: {
            approval: '@agnes/base',
            checkpoint: '@agnes/base',
            ledger: '@agnes/base',
            sandbox: '@agnes/base',
            verifier: '@agnes/base',
            repair: '@agnes/base',
            artifacts: '@agnes/base',
            principals: '@agnes/base',
            platform: '@agnes/host',
            harness: '@agnes/base',
          },
        }),
      )
      expect(execFileSync(resolve(bin as string), ['--version'], { encoding: 'utf8' })).toMatch(
        /^agh 0\.0\.0 node 24\./,
      )
      expect(execFileSync(resolve(bin as string), ['--help'], { encoding: 'utf8' })).toContain('agh [prompt]')
      const forwardedHelp = spawnSync(resolve(bin as string), ['daemon', 'start', '--help'], {
        encoding: 'utf8',
        env,
      })
      expect(forwardedHelp.status).toBe(2)
      expect(forwardedHelp.stdout).toBe('')
      expect(forwardedHelp.stderr).toContain('unknown daemon argument --help')
      const started = spawnSync(resolve(bin as string), ['daemon', 'start'], {
        encoding: 'utf8',
        env,
        cwd: workspace,
        timeout: 30000,
      })
      expect(
        started.status,
        JSON.stringify({ stdout: started.stdout, stderr: started.stderr, error: started.error }),
      ).toBe(0)
      const status = JSON.parse(
        execFileSync(resolve(bin as string), ['daemon', 'status'], { encoding: 'utf8', env, cwd: workspace }),
      ) as { running: boolean; owner: { pid: number } }
      expect(status.running).toBe(true)
      expect(
        execFileSync(resolve(bin as string), ['stats', 'deviation', '--json'], {
          encoding: 'utf8',
          env,
        }).trim(),
      ).toBe('[]')
      expect(
        execFileSync(resolve(bin as string), ['consent', 'LOCAL'], {
          encoding: 'utf8',
          env,
        }),
      ).toContain('telemetry consent for local-dev: LOCAL')
      const doctor = JSON.parse(
        execFileSync(resolve(bin as string), ['doctor', 'binary', '--json', '--cwd', workspace], {
          encoding: 'utf8',
          env,
        }),
      ) as { name: string; status: string; detail: string[] }[]
      expect(doctor).toEqual([
        {
          name: 'binary',
          status: 'ok',
          detail: ['sea: yes', 'jiti cache write/read verified'],
        },
      ])
      const extensions = JSON.parse(
        execFileSync(resolve(bin as string), ['doctor', 'extensions', '--json', '--cwd', workspace], {
          encoding: 'utf8',
          env,
        }),
      ) as { name: string; status: string; detail: string[] }[]
      expect(extensions[0]?.status, JSON.stringify(extensions)).toBe('ok')
      expect(extensions[0]?.detail.join(' ')).toContain('"loaded":true')
      const loaded = new Set(
        extensions[0]?.detail.map((line) => (JSON.parse(line) as { id: string }).id) ?? [],
      )
      expect(loaded).toEqual(
        new Set([
          'agnes/tools-core',
          'agnes/tools-search',
          'agnes/tools-web',
          'agnes/compaction',
          'agnes/refine',
          'agnes/subagent',
          'agnes/mcp-search',
          'agnes/hooks-runner',
          'agnes/privacy',
          'agnes/skills',
          'agnes/computer-use',
          'agnes/code-mode',
        ]),
      )
      expect(
        execFileSync(
          resolve(bin as string),
          ['-p', 'hello', '--profile', 'local-dev', '--model', 'primary=faux/faux-1', '--cwd', workspace],
          { encoding: 'utf8', env },
        ),
      ).toBe('sea faux ok\n')
      const output = execFileSync(resolve(harness as string), [join(packageDirectory, 'index.ts')], {
        encoding: 'utf8',
        env,
        cwd: workspace,
      })
      expect(output).toBe('SEA extension test/hello loaded: pong\n')
      const cache = join(home, 'cache', 'jiti', '0.0.0')
      expect(existsSync(cache)).toBe(true)
      expect(readdirSync(cache).length).toBeGreaterThan(0)
      writeFileSync(join(packageDirectory, 'tampered.ts'), 'export const changed = true\n')
      expect(() =>
        execFileSync(resolve(bin as string), ['doctor', 'extensions', '--json', '--cwd', workspace], {
          encoding: 'utf8',
          env,
        }),
      ).toThrow()
      const children = process.platform === 'win32' ? windowsChildren(status.owner.pid) : []
      const distribution = dirname(resolve(bin as string))
      const before = process.platform === 'win32' ? windowsIdentities(distribution, children) : []
      if (process.platform === 'win32') {
        expect(children.length).toBeGreaterThan(0)
        expect(before.every((value) => typeof value === 'string')).toBe(true)
      }
      const shutdownFiles = ['owner.json', 'discovery.json', 'web-credential.json'].map((file) =>
        join(home, '.agh', 'daemon', file),
      )
      for (const file of shutdownFiles)
        expect(existsSync(file), `published before shutdown: ${file}`).toBe(true)
      const stopped = spawnSync(resolve(bin as string), ['daemon', 'stop'], {
        encoding: 'utf8',
        env,
        cwd: workspace,
        timeout: 15000,
        windowsHide: true,
      })
      expect(stopped.status, stopped.stderr).toBe(0)
      expect(stopped.stdout.trim()).toBe('stopped')
      for (const file of shutdownFiles) expect(existsSync(file), `shutdown removed ${file}`).toBe(false)
      if (process.platform === 'win32') {
        const after = windowsIdentities(distribution, [status.owner.pid, ...children])
        expect(after[0]).toBeNull()
        for (let index = 0; index < children.length; index++) expect(after[index + 1]).not.toBe(before[index])
      }
    } finally {
      spawnSync(resolve(bin as string), ['daemon', 'stop'], { env, cwd: workspace, timeout: 15_000 })
      server.kill()
      rmSync(temporary, { recursive: true, force: true })
    }
    // Multiple cold SEA launches plus daemon readiness and a real provider round-trip exceed 5s on Windows.
  }, 30000)
})
