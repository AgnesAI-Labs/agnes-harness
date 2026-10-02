import { describe, it } from 'vitest'
import { recoverNetwork, recoverRefresh, recoverSecrets } from './network-secrets-process.js'

describe.each(['default', 'reference'] as const)('%s process recovery', (kind) => {
  it('keeps a sent request uncertain after SIGKILL without sending it again', () => recoverNetwork(kind))
  it('reopens nonbearer handles and persists immediate revocation after SIGKILL', () => recoverSecrets(kind))
})
it('never resends a rotating refresh after its sender dies', recoverRefresh)
