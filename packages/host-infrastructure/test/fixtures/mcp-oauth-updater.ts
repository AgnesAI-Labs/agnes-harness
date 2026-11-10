import { createMcpOAuthStore } from '../../src/adapters/mcp-oauth-store.js'

// Child process for the cross-process store test: reads the record, then writes it back with one more
// marker in `requiredScope`, `count` times.
const [root, serverId, tag, count] = process.argv.slice(2)
if (root === undefined || serverId === undefined || tag === undefined || count === undefined)
  throw new Error('missing updater argument')

const store = createMcpOAuthStore({ root, lockTimeoutMs: 50_000 })
for (let i = 0; i < Number(count); i++)
  await store.update(serverId, async (current) => {
    const scope = current !== null && !('legacy' in current) ? current.requiredScope : []
    return { value: undefined, next: { epoch: 0, requiredScope: [...scope, `${tag}-${i}`] } }
  })
