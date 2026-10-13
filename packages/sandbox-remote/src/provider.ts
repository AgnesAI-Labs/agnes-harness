import { type SandboxCapabilities, type SandboxProvider, sandboxUnavailable } from '@agnes/extension-api'

export type RemoteSandboxProviderOptions = Readonly<{
  /** Provider id deployments select with `providers.sandbox: { provider }`. */
  id: string
  version: string
  /** Opens the one channel to the machine that runs commands. The Host keeps and closes it. */
  openTransport: NonNullable<SandboxProvider['openTransport']>
}>

/**
 * What a remote provider can promise: nothing about isolation. The command is shipped elsewhere,
 * and whatever the remote host does or does not enforce is not something this process can attest.
 */
const capabilities: SandboxCapabilities = Object.freeze({
  network: true,
  fsWrite: Object.freeze([]),
  platform: Object.freeze(['darwin', 'linux', 'win32'] as const),
  available: true,
  enforcement: Object.freeze({ level: 'none', scope: Object.freeze([]) }),
})

/**
 * A `sandbox` provider whose commands run on another machine. Export the result as the package's
 * `sandboxProvider`; the Host opens the channel from the package's config during assembly and then
 * runs its own exec gate, file policy and workspace fence over it. The provider instance therefore
 * never carries a command: `exec` refuses, so nothing can reach the remote host around the gate.
 */
export function defineRemoteSandboxProvider(options: RemoteSandboxProviderOptions): SandboxProvider {
  const { id, version, openTransport } = options
  return Object.freeze({
    id,
    version,
    capabilities,
    openTransport,
    create: () => ({
      id,
      capabilities,
      exec: async () => {
        throw sandboxUnavailable('a remote sandbox runs commands through the Host remote channel')
      },
      dispose: () => undefined,
    }),
  })
}
