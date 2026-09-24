import { describe, expect, it } from 'vitest'
import { listPackages, listSourceFiles, repoRoot } from './repo.js'

describe('repo', () => {
  it('lists every workspace package plus guards', () => {
    const names = listPackages(repoRoot())
      .map((p) => p.name)
      .sort()
    expect(names).toEqual([
      '@agnes/ai',
      '@agnes/base',
      '@agnes/bridges',
      '@agnes/channels',
      '@agnes/cli',
      '@agnes/cli-launch',
      '@agnes/cli-tui',
      '@agnes/code',
      '@agnes/cordis',
      '@agnes/cordis-loader',
      '@agnes/core',
      '@agnes/cosmokit',
      '@agnes/daemon',
      '@agnes/error-sanitization',
      '@agnes/extension-api',
      '@agnes/guards',
      '@agnes/host',
      '@agnes/mcp-transport-health',
      '@agnes/package-admin-client-node',
      '@agnes/package-isolation',
      '@agnes/package-manager',
      '@agnes/plugin-runtime',
      '@agnes/protocol',
      '@agnes/protocol-validation',
      '@agnes/resource-control-cli',
      '@agnes/resource-control-client-node',
      '@agnes/resource-control-contracts',
      '@agnes/resource-control-daemon',
      '@agnes/resource-control-runtime',
      '@agnes/resource-control-store',
      '@agnes/resource-control-web',
      '@agnes/resource-control-worker',
      '@agnes/runtime-python',
      '@agnes/sandbox-remote',
      '@agnes/sdk',
      '@agnes/system-node',
      '@agnes/web',
      '@agnes/web-admin-frame',
      '@agnes/web-client',
      '@agnes/web-server',
      '@agnes/web-slots',
      '@agnes/web-ui',
      '@agnes/web-units',
      '@agnes/worker-runtime',
    ])
  })
  it('lists .ts sources excluding gen and dist', () => {
    const files = listSourceFiles(`${repoRoot()}/packages/protocol`)
    expect(files.every((f) => f.endsWith('.ts'))).toBe(true)
    expect(files.some((f) => f.split(sep).includes('gen'))).toBe(false)
  })
})

import { sep } from 'node:path'
