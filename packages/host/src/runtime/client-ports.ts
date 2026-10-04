import {
  type ClientBootstrapResult,
  type ClientCallHeader,
  type ClientHello,
  type ClientJsonOperation,
  type ClientOperationTypes,
  RuntimeClientOperations,
  type RuntimeError,
} from '@agnes/protocol/runtime'

type Outcome<T> = { ok: true; value: T } | { ok: false; error: RuntimeError }
export type HostRuntimeClientCaller = Readonly<{ principalId: 'local'; generation: string }>
type Query = {
  [K in ClientJsonOperation]: (typeof RuntimeClientOperations)[K]['kind'] extends 'query' ? K : never
}[ClientJsonOperation]
type Queries = {
  readonly [K in Query]?: (
    input: ClientOperationTypes[K]['input'],
    header: ClientCallHeader,
    caller: HostRuntimeClientCaller,
  ) => Promise<Outcome<ClientOperationTypes[K]['output']>>
}

/** Deployment-owned adapters to selected services. Transport authentication grants no C14 rights. */
export type HostRuntimeClientInstallation = Readonly<{
  queries: Queries
  bootstrap?(input: ClientHello, caller: HostRuntimeClientCaller): Promise<Outcome<ClientBootstrapResult>>
  authorize?(
    caller: HostRuntimeClientCaller,
    request: Readonly<{ operation: Query | 'bootstrap'; input: unknown; header?: ClientCallHeader }>,
  ): Promise<Outcome<true>>
}>

export type HostRuntimeClientPorts = {
  [K in Query]?: (
    input: ClientOperationTypes[K]['input'],
    header: ClientCallHeader,
  ) => Promise<Outcome<ClientOperationTypes[K]['output']>>
} & {
  bootstrap?(input: ClientHello): Promise<Outcome<ClientBootstrapResult>>
}

/** Assemble only explicitly installed reads, with authorization before any backend access. */
export function createHostRuntimeClientPorts(
  installation: HostRuntimeClientInstallation | undefined,
  caller: HostRuntimeClientCaller,
): HostRuntimeClientPorts {
  const authorize = installation?.authorize
  if (!installation || !authorize) return {}
  const identity = Object.freeze({ ...caller })
  const ports: HostRuntimeClientPorts = {}
  for (const operation of Object.keys(RuntimeClientOperations) as ClientJsonOperation[]) {
    if (RuntimeClientOperations[operation].kind !== 'query') continue
    const name = operation as Query
    const backend = installation.queries[name]
    if (!backend) continue
    // Each key selects its own validated wire input/output pair. Heterogeneous functions have
    // an intersection input at this loop boundary; no command or unknown name enters the map.
    Object.assign(ports, {
      [name]: async (input: never, header: ClientCallHeader) => {
        const grant = await authorize(identity, { operation: name, input, header })
        return grant.ok ? backend(input, header, identity) : grant
      },
    })
  }
  if (installation.bootstrap) {
    const backend = installation.bootstrap
    ports.bootstrap = async (input) => {
      const grant = await authorize(identity, { operation: 'bootstrap', input })
      return grant.ok ? backend(input, identity) : grant
    }
  }
  return Object.freeze(ports)
}
