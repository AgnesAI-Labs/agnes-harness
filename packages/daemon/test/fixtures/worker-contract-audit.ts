import { strictEqual } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLoader } from '@agnes/host'
import { observabilityKind } from '@agnes/observability/contract'
import {
  providedExternalModules,
  providedExternalVersions,
  checkProvidedExternals,
} from '@agnes/plugin-runtime/provided-externals'
import { deferredProducerKind, deferredQueueKind } from '@agnes/plugin-runtime/deferred-contract'

const hostRequire = createRequire(createRequire(import.meta.url).resolve('@agnes/host'))
const { gitWorktreeKind } = await import(hostRequire.resolve('@agnes/git-worktree-contract'))
const { intelligentUiKind, uiDataSourceKind } = await import(
  hostRequire.resolve('@agnes/intelligent-ui-contract')
)

// Run outside Vitest's shared module graph. Decoy dependencies must never supply kind tokens.
const root = mkdtempSync(join(tmpdir(), 'agnes-kind-audit-'))
const kinds = {
  observabilityKind,
  intelligentUiKind,
  uiDataSourceKind,
  gitWorktreeKind,
  deferredProducerKind,
  deferredQueueKind,
}
try {
  for (const name of ['@agnes/host', '@agnes/host/feedback-contract']) {
    strictEqual(Object.hasOwn(providedExternalModules, name), false)
    strictEqual(Object.hasOwn(providedExternalVersions, name), false)
    let refused = false
    try {
      checkProvidedExternals({ [name]: '*' })
    } catch {
      refused = true
    }
    strictEqual(refused, true, 'Host modules cannot be provided to plugins')
  }
  for (const name of [
    '@agnes/observability',
    '@agnes/intelligent-ui-contract',
    '@agnes/git-worktree-contract',
    '@agnes/plugin-runtime',
  ]) {
    const directory = join(root, 'node_modules', name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        name,
        exports: {
          '.': './index.js',
          './contract': './index.js',
          './deferred-contract': './index.js',
        },
      }),
    )
    writeFileSync(join(directory, 'index.js'), 'throw new Error("decoy contract evaluated")')
  }
  const entry = join(root, 'index.ts')
  writeFileSync(
    entry,
    `
    export { observabilityKind } from '@agnes/observability/contract'
    export { intelligentUiKind, uiDataSourceKind } from '@agnes/intelligent-ui-contract'
    export { gitWorktreeKind } from '@agnes/git-worktree-contract'
    export { deferredProducerKind, deferredQueueKind } from '@agnes/plugin-runtime/deferred-contract'
    export { observabilityKind as runtimeKind } from ${JSON.stringify(fileURLToPath(new URL('../../../observability/src/index.ts', import.meta.url)))}
  `,
  )
  const loader = createLoader({ cacheDir: join(root, 'cache'), hostRoot: root, agnesVersion: '0.0.0' })
  for (let attempt = 0; attempt < 2; attempt++) {
    const imported = await loader.import(entry)
    for (const [name, token] of Object.entries(kinds)) strictEqual(imported[name], token, name)
    strictEqual(imported.runtimeKind, observabilityKind, 'exporter runtime uses the Host contract')
  }
  console.log(JSON.stringify(Object.keys(kinds)))
} finally {
  rmSync(root, { recursive: true, force: true })
}
