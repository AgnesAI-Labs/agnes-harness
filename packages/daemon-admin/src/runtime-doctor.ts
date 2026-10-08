import { realpath } from 'node:fs/promises'
import { detectBackend } from '@agnes/base/sandbox'
import { createExec, type DoctorOptions, runDoctor } from '@agnes/host'

/** Reuses the exact runnable-boundary probe used by the sandbox seam. No authority is granted. */
export async function runtimeDoctor(options: DoctorOptions) {
  return runDoctor({
    ...options,
    sandbox:
      options.sandbox ??
      (async () => {
        const root = await realpath(options.home)
        const exec = createExec({ defaultTimeoutMs: 3000 })
        try {
          const backend = await detectBackend({
            level: 'L1',
            shell: 'posix',
            options: { cwd: root, allowPaths: [], denyPaths: [root], network: 'deny' },
            probeExec: (argv, input) => exec.run(argv, input),
            log: { info() {}, warn() {}, error() {}, debug() {} },
            ...(options.signal ? { signal: options.signal } : {}),
          })
          return backend.name !== 'none'
        } finally {
          await exec.killAll()
        }
      }),
  })
}
