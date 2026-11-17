import { dirname } from 'node:path'

export function marketEndpoint(owner: { socketPath: string; pid: number; processStartId: string }) {
  const pipe = owner.socketPath.startsWith('\\\\.\\pipe\\')
  return {
    transport: {
      kind: 'unix' as const,
      path: owner.socketPath,
      ...(pipe ? { serverIdentity: { pid: owner.pid, processStartId: owner.processStartId } } : {}),
    },
    socketDirectory: pipe ? undefined : dirname(owner.socketPath),
  }
}
