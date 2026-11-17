import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { MemorySessionWorkspaces } from '@agnes/daemon-foundation/storage/lister'
import {
  MemoryWorkspaceBindings,
  MemoryWorkspaceStore,
  WorkspaceCatalog,
  workspaceIdFor,
} from '@agnes/daemon-foundation/storage/workspaces'
import { resolveWorkspaceDirectory } from '@agnes/host'
import { expect, it } from 'vitest'
import { openTestHost } from './host.js'

it('rejects public legacy launches despite injected grant, source and schedule metadata', async () => {
  const h = await openTestHost()
  const legacy = join(await realpath(h.dataDir), 'chats')
  await mkdir(legacy)
  const bindings = new MemoryWorkspaceBindings()
  const catalog = new WorkspaceCatalog(
    new MemoryWorkspaceStore(),
    new MemorySessionWorkspaces(),
    resolveWorkspaceDirectory,
    () => 0,
    bindings,
    { legacy },
  )
  await catalog.add(legacy)
  const endpoint = h.endpoint({ workspaces: catalog })
  try {
    await endpoint.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        _meta: { 'ai.agnes.harness': { clientId: 'legacy-injection-review' } },
      },
    })
    for (const cwd of [legacy, `${legacy}/.`]) {
      const key = `injected-${cwd.length}`
      const response = await endpoint.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: {
          cwd,
          mcpServers: [],
          _meta: {
            'ai.agnes.harness': {
              sessionKey: key,
              allowPrivateRoot: true,
              managedRole: 'legacy',
              scheduleId: 'existing-task',
              runId: 'existing-run',
              legacyChatReadGrant: {
                sessionKey: key,
                workspaceId: workspaceIdFor(legacy),
                root: legacy,
                source: 'schedule',
                directoryIdentity: '1:2',
              },
              origin: { kind: 'schedule', sessionKey: key },
            },
          },
        },
      })
      expect(response).toMatchObject({
        error: { message: 'CAPABILITY_DENIED', data: { reason: 'legacy workspace requires trusted launch' } },
      })
      expect(bindings.get(key)).toBeUndefined()
    }
  } finally {
    await endpoint.close()
    await h.close()
  }
})
