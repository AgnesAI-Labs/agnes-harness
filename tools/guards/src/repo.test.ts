import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listPackages, listSourceFiles, repoRoot } from './repo.js'

describe('repo', () => {
  it('keeps both original Mars videos clickable with local accessible covers and current reproduction guides', () => {
    const root = repoRoot()
    for (const [suffix, video] of [
      ['', 'absoBkphEHE'],
      ['.zh-CN', 'QbmD2KVli5Y'],
    ] as const) {
      const readme = readFileSync(join(root, `README${suffix}.md`), 'utf8')
      const preview = readme.match(
        /\[!\[([^\]]+)\]\((docs\/assets\/readme\/mars-rescue[^)]+)\)\]\((https:\/\/youtu\.be\/[^)]+)\)/,
      )
      expect(preview, `missing clickable ${suffix || 'English'} video`).not.toBeNull()
      expect(preview?.[1]?.trim().length).toBeGreaterThan(20)
      expect(preview?.[2]).toBe(`docs/assets/readme/mars-rescue${suffix}.svg`)
      expect(preview?.[3]).toBe(`https://youtu.be/${video}`)
      const cover = readFileSync(join(root, preview?.[2] ?? ''), 'utf8')
      expect(cover).toMatch(/<title id="title">[^<]+<\/title>/)
      expect(cover).toMatch(/<desc id="desc">[^<]+<\/desc>/)
      expect(cover).toContain('data:image/jpeg;base64,')
      expect(cover).toContain('aria-labelledby="title desc"')
      const guide = `docs/guide/mars-world${suffix}.md`
      expect(readme).toContain(`](${guide})`)
      expect(existsSync(join(root, guide))).toBe(true)
      expect(existsSync(join(root, `examples/mhs/mars-rescue/README${suffix}.md`))).toBe(true)
    }
  })
  it('lists every workspace package plus guards', () => {
    const names = listPackages(repoRoot())
      .map((p) => p.name)
      .sort()
    expect(names).toEqual([
      '@agnes/ai',
      '@agnes/base',
      '@agnes/batch',
      '@agnes/bridges',
      '@agnes/channels',
      '@agnes/cli',
      '@agnes/cli-tui',
      '@agnes/code',
      '@agnes/cordis',
      '@agnes/cordis-loader',
      '@agnes/core',
      '@agnes/core-child-control',
      '@agnes/core-common',
      '@agnes/core-effects',
      '@agnes/core-ledger',
      '@agnes/cosmokit',
      '@agnes/daemon',
      '@agnes/daemon-admin',
      '@agnes/daemon-foundation',
      '@agnes/daemon-rpc',
      '@agnes/daemon-surfaces',
      '@agnes/e2e-web',
      '@agnes/error-sanitization',
      '@agnes/extension-api',
      '@agnes/git-worktree-contract',
      '@agnes/guards',
      '@agnes/history-index',
      '@agnes/host',
      '@agnes/host-artifacts',
      '@agnes/host-common',
      '@agnes/host-computer-use',
      '@agnes/host-extensions',
      '@agnes/host-infrastructure',
      '@agnes/host-providers',
      '@agnes/intelligent-ui-contract',
      '@agnes/loop-default',
      '@agnes/memory-file',
      '@agnes/mhs',
      '@agnes/mhs-device',
      '@agnes/mhs-hub',
      '@agnes/mhs-ui',
      '@agnes/model-adapters',
      '@agnes/observability',
      '@agnes/package-isolation',
      '@agnes/package-manager',
      '@agnes/plugin-runtime',
      '@agnes/plugin-streams',
      '@agnes/protocol',
      '@agnes/protocol-validation',
      '@agnes/resource-control-cli',
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
      '@agnes/web-admin',
      '@agnes/web-client',
      '@agnes/web-conversation',
      '@agnes/web-foundation',
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
    const fixture = mkdtempSync(join(tmpdir(), 'agh-repo-scan-'))
    try {
      for (const file of [
        'packages/src/main.ts',
        'packages/src/refusal.test.ts',
        'packages/fixtures/source.tsx',
        'packages/src/main.mts',
        'packages/src/main.cts',
        'tools/build.cjs',
        'tools/build.js',
        'examples/plugin.jsx',
        'packages/dist/output.ts',
        'packages/gen/output.ts',
        'packages/generated/output.ts',
        'packages/node_modules/dep.ts',
      ]) {
        const path = join(fixture, file)
        mkdirSync(join(path, '..'), { recursive: true })
        writeFileSync(path, '')
      }
      symlinkSync(join(fixture, 'packages/src/main.ts'), join(fixture, 'tools/linked.ts'))
      symlinkSync(join(fixture, 'packages/fixtures'), join(fixture, 'tools/linked-dir'))
      const tsSources = [
        'packages/fixtures/source.tsx',
        'packages/src/main.cts',
        'packages/src/main.mts',
        'packages/src/main.ts',
        'packages/src/refusal.test.ts',
        'tools/linked-dir/source.tsx',
        'tools/linked.ts',
      ]
        .map((path) => join(fixture, path))
        .sort()
      expect(listSourceFiles(fixture)).toEqual(tsSources)
      const roots = ['packages', 'tools', 'examples', 'missing'].map((dir) => join(fixture, dir))
      expect(listSourceFiles(roots)).toEqual(tsSources)
      expect(
        listSourceFiles(roots, { extensions: ['.ts', '.mts', '.cts', '.tsx', '.js', '.cjs', '.jsx'] }),
      ).toEqual(
        [
          ...tsSources,
          ...['tools/build.cjs', 'tools/build.js', 'examples/plugin.jsx'].map((path) => join(fixture, path)),
        ].sort(),
      )
      expect(
        listSourceFiles(roots, {
          excludeDirs: ['src', 'fixtures', 'linked-dir', 'dist', 'gen', 'generated', 'node_modules'],
        }),
      ).toEqual([join(fixture, 'tools/linked.ts')])
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
