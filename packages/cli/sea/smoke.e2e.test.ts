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
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeHome } from '@agnes/host'
import { createPackageManager, emptyLock, packageDir, parseSource, writeLock } from '@agnes/package-manager'
import { describe, expect, it } from 'vitest'
import { windowsChildren, windowsIdentities } from './windows-processes.js'

const bin = process.env.AGNES_SEA_BIN
const harness = process.env.AGNES_SEA_LOADER_HARNESS

describe.skipIf(!bin || !harness)('SEA smoke', () => {
  it('runs production commands and loads a TypeScript extension through the SEA loader', async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'agnes-sea-'))
    const home = join(temporary, 'home')
    const distributionRoot = join(temporary, 'distribution')
    const binary = join(distributionRoot, basename(bin as string))
    const loaderHarness = join(distributionRoot, basename(harness as string))
    // Session workspaces cannot contain the private .agh state under home.
    const workspace = join(temporary, 'workspace')
    const server = spawn(
      process.env.AGNES_SEA_NODE || process.execPath,
      [fileURLToPath(new URL('./fixtures/openai-server.mjs', import.meta.url))],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    const env = { ...process.env, AGH_HOME: home, HOME: home, NODE_PATH: '', NODE_OPTIONS: '' }
    try {
      // Run outside the checkout so native dependency lookup cannot fall back to its node_modules.
      cpSync(dirname(resolve(bin as string)), distributionRoot, { recursive: true, dereference: true })
      cpSync(resolve(harness as string), loaderHarness)
      mkdirSync(workspace, { recursive: true })
      // Only fixture generation uses checkout sharp. The command below executes the distributed
      // SEA, daemon and worker; the loopback provider checks actual returned resized pixels.
      const sharp = createRequire(new URL('../../base/package.json', import.meta.url))('sharp')
      for (const format of ['png', 'jpeg'] as const)
        writeFileSync(
          join(workspace, `sea-image.${format}`),
          await sharp({
            create: {
              width: 1024,
              height: 512,
              channels: 3,
              background: 'white',
            },
          })
            [format]()
            .toBuffer(),
        )
      const layout = initializeHome(home, 'local-dev').paths
      const profileDir = layout.config
      const secrets = join(layout.credentials, 'test')
      if (process.platform === 'win32') {
        // initializeHome has already created the home folders privately; createPrivateDirectory
        // creates exclusively, so the distributed native module only adds what is still missing.
        const distribution = dirname(binary)
        execFileSync(
          join(distribution, 'runtime', 'node.exe'),
          [
            '-e',
            `
          const api=require(${JSON.stringify(join(distribution, 'node_modules/@agnes/system-node/dist/native/agnes-system.node'))});
          const fs=require('node:fs');
          for(const path of ${JSON.stringify([home, join(home, 'profiles'), profileDir, layout.credentials, secrets])}) if(!fs.existsSync(path)) api.createPrivateDirectory(path);
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
      const sourceDirectory = join(temporary, 'hello-ext')
      cpSync(new URL('./fixtures/hello-ext/', import.meta.url), sourceDirectory, { recursive: true })
      expect(JSON.parse(readFileSync(join(sourceDirectory, 'package.json'), 'utf8'))).toMatchObject({
        name: 'test/hello',
        agnes: { plugins: [{ id: 'ext:test/hello', export: 'default', apiRange: '^5.0.0' }] },
      })
      writeLock(profileDir, {
        ...emptyLock('local-dev', '0.0.0'),
        resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
        seams: Object.fromEntries(
          ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map(
            (kind) => [kind, { provider: 'local' }],
          ),
        ),
        policySnapshot: { capabilityCeiling: ['tools'], workspacePackages: 'require-project-trust' },
      })
      const manager = createPackageManager({
        dataDir: layout.ledger,
        cwd: temporary,
        agnesVersion: '0.0.0',
        references: async () => [],
      })
      const source = parseSource('file:./hello-ext')
      const preview = await manager.inspect(profileDir, source)
      await manager.install(profileDir, source, { expectedIntegrity: preview.integrity })
      const row = (await manager.inventory(profileDir)).packages.find((row) => row.id === 'test/hello')
      if (!row) throw new Error('SEA fixture package was not installed')
      await manager.trust(profileDir, row.id, {
        integrity: row.entry.integrity,
        capabilityHash: row.capabilityHash,
      })
      // The loader harness imports directly; Host keeps the external package disabled without a runtime pin.
      const packageDirectory = packageDir(layout.ledger, 'local-dev', row.id)
      expect(execFileSync(binary, ['--version'], { encoding: 'utf8' })).toMatch(/^agh 0\.0\.0 node 24\./)
      expect(execFileSync(binary, ['--help'], { encoding: 'utf8' })).toContain('agh [prompt]')
      const forwardedHelp = spawnSync(binary, ['daemon', 'start', '--help'], {
        encoding: 'utf8',
        env,
      })
      // CLI-wide --help now succeeds before daemon argument parsing; unknown options still fail.
      expect(forwardedHelp.status).toBe(0)
      expect(forwardedHelp.stdout).toBe(execFileSync(binary, ['--help'], { encoding: 'utf8' }))
      expect(forwardedHelp.stderr).toBe('')
      const unknownOption = spawnSync(binary, ['daemon', 'start', '--unknown-sea-fixture-option'], {
        encoding: 'utf8',
        env,
      })
      expect(
        unknownOption.status,
        JSON.stringify({
          stdout: unknownOption.stdout,
          stderr: unknownOption.stderr,
          error: unknownOption.error,
        }),
      ).toBe(2)
      expect(unknownOption.stdout).toBe('')
      expect(unknownOption.stderr).toContain('unknown daemon argument --unknown-sea-fixture-option')
      const started = spawnSync(binary, ['daemon', 'start'], {
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
        execFileSync(binary, ['daemon', 'status'], { encoding: 'utf8', env, cwd: workspace }),
      ) as { running: boolean; owner: { pid: number } }
      expect(status.running).toBe(true)
      expect(
        execFileSync(binary, ['stats', 'deviation', '--json'], {
          encoding: 'utf8',
          env,
        }).trim(),
      ).toBe('[]')
      expect(
        execFileSync(binary, ['consent', 'LOCAL'], {
          encoding: 'utf8',
          env,
        }),
      ).toContain('telemetry consent for local-dev: LOCAL')
      const doctor = JSON.parse(
        execFileSync(binary, ['doctor', 'binary', '--json', '--cwd', workspace], {
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
        execFileSync(binary, ['doctor', 'extensions', '--json', '--cwd', workspace], {
          encoding: 'utf8',
          env,
        }),
      ) as { name: string; status: string; detail: string[] }[]
      expect(extensions[0]?.status, JSON.stringify(extensions)).toBe('ok')
      expect(extensions[0]?.detail.join(' ')).toContain('"loaded":true')
      const loaded = new Set(
        extensions[0]?.detail.map((line) => (JSON.parse(line) as { id: string }).id) ?? [],
      )
      // The fixture ceiling withholds services and projections, so the official extensions that
      // declare either (schedule, heads-up, workflow and the like) are not in this set.
      expect(loaded).toEqual(
        new Set([
          'agnes/tools-core',
          'agnes/tools-search',
          'agnes/tools-web',
          'agnes/jobs',
          'agnes/compaction',
          'agnes/refine',
          'agnes/subagent',
          'agnes/mcp-search',
          'agnes/hooks-runner',
          'agnes/privacy',
          'agnes/plugin-creator',
          'agnes/skills',
          'agnes/computer-use',
          'agnes/code-mode',
          'agnes/plan-mode',
          'agnes/mcp-resources',
          'agnes/session-query',
          'agnes/lsp',
        ]),
      )
      expect(
        execFileSync(
          binary,
          ['-p', 'hello', '--profile', 'local-dev', '--model', 'primary=faux/faux-1', '--cwd', workspace],
          { encoding: 'utf8', env },
        ),
      ).toBe('sea faux ok\n')
      expect(
        execFileSync(
          binary,
          [
            '-p',
            'SEA_IMAGE_SMOKE',
            '--profile',
            'local-dev',
            '--model',
            'primary=faux/faux-1',
            '--cwd',
            workspace,
          ],
          {
            encoding: 'utf8',
            env: { ...env, NODE_PATH: '', NODE_OPTIONS: '' },
            timeout: 30_000,
          },
        ),
      ).toBe('sea image smoke ok\n')
      const output = execFileSync(loaderHarness, [join(packageDirectory, 'index.ts')], {
        encoding: 'utf8',
        env,
        cwd: workspace,
      })
      expect(output).toBe('SEA extension test/hello loaded: pong\n')
      const cache = join(home, 'cache', 'jiti', '0.0.0')
      expect(existsSync(cache)).toBe(true)
      expect(readdirSync(cache).length).toBeGreaterThan(0)
      const tampered = join(packageDirectory, 'tampered.ts')
      writeFileSync(tampered, 'export const changed = true\n')
      try {
        expect(() =>
          execFileSync(binary, ['doctor', 'extensions', '--json', '--cwd', workspace], {
            encoding: 'utf8',
            env,
          }),
        ).toThrow()
      } finally {
        // Restore verified bytes so subsequent daemon scope resolution can perform normal shutdown.
        rmSync(tampered)
      }
      const children = process.platform === 'win32' ? windowsChildren(status.owner.pid) : []
      const distribution = dirname(binary)
      const before = process.platform === 'win32' ? windowsIdentities(distribution, children) : []
      if (process.platform === 'win32') {
        expect(children.length).toBeGreaterThan(0)
        expect(before.every((value) => typeof value === 'string')).toBe(true)
      }
      const shutdownFiles = ['owner.json', 'discovery.json', 'web-credential.json'].map((file) =>
        join(home, 'daemon', file),
      )
      for (const file of shutdownFiles)
        expect(existsSync(file), `published before shutdown: ${file}`).toBe(true)
      const stopped = spawnSync(binary, ['daemon', 'stop'], {
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
      spawnSync(binary, ['daemon', 'stop'], { env, cwd: workspace, timeout: 15_000 })
      server.kill()
      rmSync(temporary, { recursive: true, force: true })
    }
    // Multiple cold SEA launches plus daemon readiness and a real provider round-trip exceed 5s on Windows.
  }, 60000)
})
