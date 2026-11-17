import type { TransportFactory } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { rpcDiagnostics } from './helpers/rpc-diagnostics.js'

it('reports the actual rejected RPC method and safe data codes without request or error contents', async () => {
  let incoming: Parameters<TransportFactory>[0] | undefined
  const send = vi.fn(async () => undefined)
  const report = vi.fn()
  const onMessage = vi.fn()
  const factory: TransportFactory = async (handlers) => {
    incoming = handlers
    return { kind: 'unix', send, close: async () => undefined }
  }
  const handlers = { onMessage, onClose: vi.fn() }
  const transport = await rpcDiagnostics(factory, report)(handlers)
  await transport.send({
    jsonrpc: '2.0',
    id: 7,
    method: '_agnes/v1/packages.install',
    params: { token: 'REQUEST-SECRET' },
  })
  const rejection = {
    jsonrpc: '2.0' as const,
    id: 7,
    error: {
      code: -32011,
      message: 'PRIVATE-CREDENTIAL',
      data: { code: 'SEMANTIC_REJECTED', reason: 'E_PACKAGE_STATE', private: 'RESPONSE-SECRET' },
    },
  }
  incoming?.onMessage(rejection)
  expect(report).toHaveBeenCalledExactlyOnceWith({
    method: '_agnes/v1/packages.install',
    code: -32011,
    data: { code: 'SEMANTIC_REJECTED', reason: 'E_PACKAGE_STATE' },
  })
  expect(onMessage).toHaveBeenCalledWith(rejection)
  expect(JSON.stringify(report.mock.calls)).not.toMatch(/SECRET|CREDENTIAL/)
  incoming?.onMessage(rejection)
  expect(report).toHaveBeenCalledTimes(1)
  await transport.send({ jsonrpc: '2.0', id: 8, method: '_agnes/v1/packages.inspect', params: {} })
  incoming?.onMessage({
    ...rejection,
    id: 8,
    error: { ...rejection.error, data: { code: 'secret://token', reason: '/private/home' } },
  })
  expect(report).toHaveBeenLastCalledWith({ method: '_agnes/v1/packages.inspect', code: -32011, data: {} })
  await transport.send({ jsonrpc: '2.0', id: 9, method: '_agnes/v1/packages.enable', params: {} })
  incoming?.onMessage({
    ...rejection,
    id: 9,
    error: { ...rejection.error, data: { code: 'E_PACKAGE_INTEGRITY', reason: 'clean-home-required' } },
  })
  expect(report).toHaveBeenLastCalledWith({
    method: '_agnes/v1/packages.enable',
    code: -32011,
    data: { code: 'E_PACKAGE_INTEGRITY', reason: 'clean-home-required' },
  })
  await transport.close()
})
