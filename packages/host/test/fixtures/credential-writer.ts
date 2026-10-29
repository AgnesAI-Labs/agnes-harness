import { createCredentialStore } from '@agnes/host-infrastructure/adapters/credential-store'

const [root, ref, value] = process.argv.slice(2)
if (root === undefined || ref === undefined || value === undefined) throw new Error('missing writer argument')

const store = createCredentialStore({ root })
await store.putApiKey(ref, value)
