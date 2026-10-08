import { realpath } from 'node:fs/promises'
import { detectBackend } from '@agnes/base/sandbox'
import type { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { createExec, type DoctorOptions, runDoctor } from '@agnes/host'
import { rpcError } from '@agnes/protocol'
import type { DoctorParams } from '@agnes/protocol/gen/app-server'

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
export function registerDoctor(endpoint: LocalEndpoint, options: DoctorOptions): void {
  endpoint.register('_agnes/v1/doctor.run', async (input, context) => {
    if (context.conn.authKind !== 'local' || context.conn.credentialKind !== 'local')
      throw rpcError('CAPABILITY_DENIED')
    const params = input as DoctorParams
    return runtimeDoctor({ ...options, probeAccounts: params.probeAccounts === true, signal: context.signal })
  })
}
