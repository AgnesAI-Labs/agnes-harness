import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BuildIdentity, ConformanceHarness } from '../../../packages/extension-api/testkit/index.js'
import { canonicalJsonDigest } from '../../../packages/protocol/src/runtime/index.js'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
let cached: BuildIdentity | undefined

/** Capture this checkout once; every built-in binder reports the same immutable build. */
export function getConformanceBuildIdentity(): BuildIdentity {
  if (cached !== undefined) return cached
  const codeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  const sdk = JSON.parse(readFileSync(join(ROOT, 'packages/extension-api/package.json'), 'utf8')) as {
    name: string
    version: string
  }
  const specVersion = 'runtime-services-1'
  cached = Object.freeze({
    codeSha,
    buildDigest: canonicalJsonDigest({ codeSha, specVersion }),
    lockDigest: createHash('sha256')
      .update(readFileSync(join(ROOT, 'pnpm-lock.yaml')))
      .digest('hex'),
    specVersion,
    sdkVersion: sdk.version,
    sdkDigest: canonicalJsonDigest({ name: sdk.name, version: sdk.version }),
    platform: `${process.platform}-${process.arch}`, // guards-allow-platform: evidence only, no branch
  })
  return cached
}

/** Attach checkout metadata when binding bundled reference helpers with standalone fixture labels. */
export function withConformanceBuild(harness: ConformanceHarness): ConformanceHarness {
  const build = getConformanceBuildIdentity()
  return {
    ...harness,
    registerCase(registration) {
      harness.registerCase({
        ...registration,
        build,
        async run(context) {
          return { ...(await registration.run(context)), build }
        },
      })
    },
  }
}

/**
 * Marks every case registered through it as run on test stand-ins for deployment-owned ports: a case
 * without a fixture of its own records `restricted-effects`, and each says which stand-ins it ran on.
 */
export function withDeploymentStandIns(harness: ConformanceHarness, standIns: string): ConformanceHarness {
  return {
    ...harness,
    registerCase(registration) {
      harness.registerCase({
        ...registration,
        async run(context) {
          const input = await registration.run(context)
          return {
            ...input,
            fixture: input.fixture ?? 'restricted-effects',
            diagnostic: input.diagnostic === undefined ? standIns : `${input.diagnostic}; ${standIns}`,
          }
        },
      })
    },
  }
}
