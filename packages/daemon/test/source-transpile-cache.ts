import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { demoProvider } from '@agnes/package-manager'
import { sourceTranspileCache } from '../../../tools/test-fixtures/source-transpile-cache.mjs'

export { sourceTranspileCache }
export const SOURCE_WORKER_STARTUP_MS = 120_000

/** Defaults for fresh local-dev profiles in source worker tests. */
export function configureSourceWorkerProfile(home: string) {
  writeFileSync(
    join(home, 'profiles', 'local-dev', 'profile.yaml'),
    JSON.stringify({
      name: 'local-dev',
      cacheDir: sourceTranspileCache(),
      limits: { 'worker.startup_ms': SOURCE_WORKER_STARTUP_MS },
      // An explicit profile replaces the daemon's absent-profile Demo fallback.
      provider: demoProvider(),
    }),
    { flag: 'wx' },
  )
}
