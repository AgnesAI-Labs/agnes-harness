import { runtimeDoctor } from '@agnes/daemon-admin/runtime-doctor'
import type { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { DoctorOptions } from '@agnes/host'
import { rpcError } from '@agnes/protocol'
import type { DoctorParams } from '@agnes/protocol/gen/app-server'

export { runtimeDoctor } from '@agnes/daemon-admin/runtime-doctor'

export function registerDoctor(endpoint: LocalEndpoint, options: DoctorOptions): void {
  endpoint.register('_agnes/v1/doctor.run', async (input, context) => {
    if (context.conn.authKind !== 'local' || context.conn.credentialKind !== 'local')
      throw rpcError('CAPABILITY_DENIED')
    const params = input as DoctorParams
    return runtimeDoctor({ ...options, probeAccounts: params.probeAccounts === true, signal: context.signal })
  })
}
