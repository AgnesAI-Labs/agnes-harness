import { describe, it } from 'vitest'
import { recoverTicketKeys } from './artifact-ticket-key-process.js'

describe.each(['default', 'reference'] as const)('%s ticket material cold recovery', (kind) => {
  it('opens the retained original version after SIGKILL and cold-checks emergency revocation', async () => {
    await recoverTicketKeys(kind)
  }, 30000)
})
