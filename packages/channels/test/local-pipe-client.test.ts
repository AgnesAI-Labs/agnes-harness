import type { DaemonDiscovery, DaemonScope } from '@agnes/daemon'
import type { Transport } from '@agnes/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { channelPipeTransport } from '../src/runner/client.js'

const path = '\\\\.\\pipe\\channel-test'
const scope: DaemonScope = {
  home: 'D:\\home',
  profile: 'local-dev',
  workspace: 'D:\\work',
  dataDir: 'D:\\data',
  profileDir: 'D:\\profile',
  daemonDir: 'D:\\daemon',
  profileFile: 'D:\\profile.json',
  ownerPath: 'D:\\owner.json',
  discoveryPath: 'D:\\discovery.json',
  webCredentialPath: 'D:\\web-key',
  scopeID: 'scope-1',
}
const config = {
  connect: { kind: 'unix' as const, path },
  workspace: scope.workspace,
  localDaemon: { profile: scope.profile },
}
const handlers = { onMessage: vi.fn(), onClose: vi.fn() }
function fixture() {
  const record: DaemonDiscovery = {
    protocol: 'agnesd-discovery',
    version: 1,
    capabilities: ['unix'],
    scopeID: scope.scopeID,
    profile: scope.profile,
    profileHash: 'hash',
    dataDir: scope.dataDir,
    socketPath: path,
    owner: {
      pid: 123,
      processStartId: '12345',
      generation: 'generation-1',
      startedAt: '2026-09-14T00:00:00Z',
    },
    ready: true,
  }
  const transport: Transport = { kind: 'unix', send: vi.fn(async () => {}), close: vi.fn(async () => {}) }
  return {
    record,
    transport,
    deps: {
      resolveDaemonScope: vi.fn(async () => scope),
      readDaemonDiscovery: vi.fn(async (): Promise<DaemonDiscovery | null> => record),
      unixTransport: vi.fn(() => async () => transport),
    },
  }
}
afterEach(() => vi.useRealTimers())
it('reads fresh identity for each connection and forwards explicit scope selection', async () => {
  const { record, deps } = fixture()
  const factory = channelPipeTransport(config, deps)
  await (await factory(handlers)).close()
  deps.readDaemonDiscovery.mockResolvedValue({
    ...record,
    owner: { ...record.owner, pid: 456, processStartId: '67890' },
  })
  await (await factory(handlers)).close()
  expect(deps.resolveDaemonScope).toHaveBeenCalledTimes(2)
  expect(deps.resolveDaemonScope).toHaveBeenCalledWith(
    expect.objectContaining({ profile: 'local-dev', workspace: scope.workspace }),
  )
  expect(deps.unixTransport).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ path, serverIdentity: { pid: 123, processStartId: '12345' } }),
  )
  expect(deps.unixTransport).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ path, serverIdentity: { pid: 456, processStartId: '67890' } }),
  )
})
it.each(['missing', 'wrong-pipe', 'untrusted'])('does not open a pipe on %s discovery', async (mode) => {
  const { record, deps } = fixture()
  if (mode === 'untrusted') deps.readDaemonDiscovery.mockRejectedValue(new Error('private record rejected'))
  else
    deps.readDaemonDiscovery.mockResolvedValue(
      mode === 'missing' ? null : { ...record, socketPath: '\\\\.\\pipe\\other' },
    )
  await expect(channelPipeTransport(config, deps)(handlers)).rejects.toThrow()
  expect(deps.unixTransport).not.toHaveBeenCalled()
})
it('does not connect after scope resolution completes beyond its deadline', async () => {
  vi.useFakeTimers()
  const { deps } = fixture()
  let resolveScope!: (value: DaemonScope) => void
  deps.resolveDaemonScope.mockReturnValue(
    new Promise((resolve) => {
      resolveScope = resolve
    }),
  )
  const rejected = expect(channelPipeTransport(config, deps, 20)(handlers)).rejects.toThrow('cannot verify')
  await vi.advanceTimersByTimeAsync(21)
  await rejected
  resolveScope(scope)
  await vi.advanceTimersByTimeAsync(0)
  expect(deps.readDaemonDiscovery).not.toHaveBeenCalled()
  expect(deps.unixTransport).not.toHaveBeenCalled()
})
it('closes a late transport rather than leaking it after timeout', async () => {
  vi.useFakeTimers()
  const { deps, transport } = fixture()
  let resolveTransport!: (value: Transport) => void
  deps.unixTransport.mockReturnValue(
    () =>
      new Promise((resolve) => {
        resolveTransport = resolve
      }),
  )
  const rejected = expect(channelPipeTransport(config, deps, 20)(handlers)).rejects.toThrow('cannot verify')
  await vi.advanceTimersByTimeAsync(21)
  await rejected
  resolveTransport(transport)
  await vi.advanceTimersByTimeAsync(0)
  expect(transport.close).toHaveBeenCalledOnce()
})
