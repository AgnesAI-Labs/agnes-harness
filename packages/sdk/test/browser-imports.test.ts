import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('bundles the browser SDK without external imports or Node implementations', async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/index.browser.ts', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    target: 'es2023',
    metafile: true,
    logLevel: 'silent',
  })
  const inputs = Object.keys(result.metafile.inputs)
  expect(inputs.length).toBeGreaterThan(10)
  expect(inputs.some((file) => file.endsWith('/transport/ws.ts'))).toBe(true)
  for (const file of inputs) {
    expect(file).not.toMatch(/\.node\.ts$/)
    expect(file).not.toMatch(/node_modules\/ws\//)
    expect(file).not.toMatch(/\/(?:stdio|unix|file-journal|sign|identity|relay)\.ts$/)
  }
  for (const output of Object.values(result.metafile.outputs)) expect(output.imports).toEqual([])
  expect(result.outputFiles).toHaveLength(1)
  const bundled = result.outputFiles[0]?.text ?? ''
  expect(bundled).not.toMatch(/(?:from|import\()\s*['"]node:/)
  expect(bundled).not.toMatch(
    /mintPortalIdentity|verifyPortalIdentity|createRelay|createSurfaceRelay|createPackageAdminClient|createExtensionClient|stripIdentity|sourceAuthProvider|signSourceAuth|createHmac|timingSafeEqual/,
  )
  // Public protocol profile schemas legitimately contain SecretRef/sourceAuthSecrets.
  // SDK credential secrecy is therefore guarded by the symbol scan above and the
  // browser-entry type assertions in api-snapshot.test.ts, not a raw substring scan.
})

it('routes the Surface subpath to its browser-empty entry', async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/surface.browser.ts', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    logLevel: 'silent',
  })
  expect(result.outputFiles[0]?.text).not.toContain('createSurfaceRelay')
  expect(result.outputFiles[0]?.text).not.toMatch(/(?:from|import\()\s*['"]node:/)
})
