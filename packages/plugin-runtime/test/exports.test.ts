import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageRoot = join(import.meta.dirname, '..')

describe('plugin-runtime exports', () => {
  it('publishes only the root, host, and testkit entrypoints', () => {
    const json = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, string>
    }

    expect(json.exports).toEqual({
      '.': './src/index.ts',
      './host': './src/host/index.ts',
      './testkit': './testkit/index.ts',
    })
  })

  it('does not re-export host lifecycle internals from the package root', () => {
    const root = readFileSync(join(packageRoot, 'src/index.ts'), 'utf8')
    expect(root).not.toMatch(
      /(?:host|testkit|MountIdentity|EntryRow|FiberLease|MultiProvider|SeamRuntime|PreparedPlugin|VerifiedRow|RowOrigin|Factory)/,
    )
  })

  it('keeps verified factories and prepared Cordis APIs off public roots', () => {
    const host = readFileSync(join(packageRoot, 'src/host/index.ts'), 'utf8')
    expect(host).toMatch(/createVerifiedRowHost/)
    const root = readFileSync(join(packageRoot, 'src/index.ts'), 'utf8')
    expect(root).not.toMatch(/createVerifiedRowHost|normalizePluginExport|resolveRowImporter/)
  })

  it('exports convergence and gate contracts only through the host entrypoint', () => {
    const host = readFileSync(join(packageRoot, 'src/host/index.ts'), 'utf8')
    expect(host).toMatch(/RuntimeConvergenceReport/)
    expect(host).toMatch(/LocalGate/)
    expect(host).toMatch(/RuntimeTargetArtifact/)
    expect(host).toMatch(/decodeCanonicalRuntimeTargetBytes/)

    const root = readFileSync(join(packageRoot, 'src/index.ts'), 'utf8')
    expect(root).not.toMatch(/TreeSnapshot|RowState|RuntimeConvergenceReport|LocalGate|RuntimeTargetArtifact/)
  })
})
