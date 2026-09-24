import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { packageIsolationRuntime } from '../tools/package-isolation-runtime.js'

const probe = vi.hoisted(() => ({ reply: '', failPublish: false }))

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (
        probe.failPublish &&
        basename(String(args[0])).startsWith('runtime.tmp-') &&
        basename(String(args[1])) === 'runtime'
      )
        throw Object.assign(new Error('injected publish failure'), { code: 'ENOSPC' })
      return actual.rename(...args)
    },
  }
})

// This is an offline assembly fixture, not an executable compatibility test. CI build:runtime
// separately downloads, verifies and executes the actual platform's pinned Node distribution.
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return {
    ...actual,
    spawnSync: ((...args: Parameters<typeof actual.spawnSync>) => {
      if (args[0].endsWith(join('node', 'darwin-arm64', 'bin', 'node'))) {
        expect(args[1]).toEqual(['-p', 'JSON.stringify(process.versions)'])
        return actual.spawnSync(process.execPath, ['-p', JSON.stringify(probe.reply)], {
          encoding: 'utf8',
        })
      }
      return actual.spawnSync(...args)
    }) as typeof actual.spawnSync,
  }
})

const directories: string[] = []
it.each(['constructor', '__proto__', 'toString', 'unsupported-platform'])(
  'rejects unsupported CLI target %s before preparing output',
  (target) => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-runtime-target-'))
    directories.push(root)
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('../tools/package-isolation-runtime.ts', import.meta.url)),
        '--target',
        target,
        '--output',
        join(root, 'runtime'),
      ],
      {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
        env: { ...process.env, AGNES_NODE_ARCHIVE: join(root, 'missing-archive') },
      },
    )
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`unsupported runtime package target: ${target}`)
    expect(existsSync(join(root, 'runtime'))).toBe(false)
  },
)
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it.each([
  { name: 'valid Node', reply: '{"node":"24.10.0"}', valid: true },
  { name: 'wrong version', reply: '{"node":"24.0.0"}', valid: false },
  { name: 'Electron host', reply: '{"node":"24.10.0","electron":"1"}', valid: false },
  { name: 'invalid output', reply: 'not json', valid: false },
  { name: 'publish failure preserves old output', reply: '{"node":"24.10.0"}', valid: true },
])('offline runtime assembly probe: $name', async ({ name, reply, valid }) => {
  probe.reply = reply
  probe.failPublish = name === 'publish failure preserves old output'
  const root = mkdtempSync(join(tmpdir(), 'agnes-runtime-package-'))
  directories.push(root)
  const distributionRoot = join(root, 'node-test')
  mkdirSync(join(distributionRoot, 'bin'), { recursive: true })
  const fakeNode = join(distributionRoot, 'bin', 'node')
  writeFileSync(fakeNode, '#!/bin/sh\nprintf \'{"node":"24.10.0"}\'\n')
  chmodSync(fakeNode, 0o755)
  writeFileSync(join(distributionRoot, 'LICENSE'), 'test license\n')
  const archive = join(root, 'node-test.tar.xz')
  const packed = spawnSync('tar', ['-cJf', archive, '-C', root, 'node-test'])
  expect(packed.status).toBe(0)
  const upstreamSha256 = createHash('sha256').update(readFileSync(archive)).digest('hex')
  const output = join(root, 'runtime')
  if (probe.failPublish) {
    mkdirSync(output)
    writeFileSync(join(output, 'old-package'), 'previous runtime')
  }
  const packaging = packageIsolationRuntime({
    outputDirectory: output,
    target: 'darwin-arm64',
    archivePath: archive,
    distribution: {
      archive: 'node-test.tar.xz',
      sha256: upstreamSha256,
      directory: 'node-test',
      executable: 'bin/node',
    },
  })
  if (probe.failPublish) {
    await expect(packaging).rejects.toThrow('injected publish failure')
    expect(readFileSync(join(output, 'old-package'), 'utf8')).toBe('previous runtime')
    return
  }
  if (!valid) {
    await expect(packaging).rejects.toThrow('packaged Node runtime probe failed')
    expect(existsSync(output)).toBe(false)
    return
  }
  const manifest = await packaging
  expect(manifest.node.upstreamArchiveSha256).toBe(upstreamSha256)
  expect(readFileSync(join(output, 'runtime.manifest.json'), 'utf8')).toContain(manifest.node.sha256)
  expect(readFileSync(join(output, 'node/darwin-arm64/LICENSE'), 'utf8')).toBe('test license\n')
  expect(readFileSync(join(output, 'node/darwin-arm64/bin/node'), 'utf8')).toContain('24.10.0')
  expect(readFileSync(join(output, 'isolation/hooks-runner.mjs')).byteLength).toBeGreaterThan(100_000)
  expect(() => readFileSync(join(output, 'node/darwin-arm64/bin/npm'))).toThrow()
})
