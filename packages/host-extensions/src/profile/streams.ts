import type { StreamHandler } from '@agnes/extension-api'
import type { StreamDeclaration } from '@agnes/protocol'
import { rpcError } from '@agnes/protocol'
import { compileExtensionSchema } from '../ext-host/json-schema.js'
import type { ProfileActivations } from './activation.js'

/** Registration stays in the Host; gateways receive only verified current registrations. */
export class ProfileStreams {
  private readonly entries = new Map<
    string,
    {
      owner: string
      integrity: string
      revision: string
      declaration: StreamDeclaration
      handler: StreamHandler
      signal: AbortSignal
      assert(): void
      validateInput(value: unknown): boolean
    }
  >()
  constructor(
    private readonly profileId: string,
    private readonly activations: ProfileActivations,
  ) {}
  register(
    input: Omit<ReturnType<ProfileStreams['describe']>, 'activationId' | 'profileId' | 'assertCurrent'>,
  ) {
    const key = `${input.owner}/${input.declaration.name}`
    if (this.entries.has(key)) throw rpcError('CAPABILITY_DENIED')
    this.entries.set(key, input)
    return () => {
      if (this.entries.get(key) === input) this.entries.delete(key)
    }
  }
  bind(input: {
    owner: string
    integrity: string
    revision: string
    declarations: readonly StreamDeclaration[]
    signal: AbortSignal
    assert(): void
  }) {
    return {
      register: (name: string, handler: StreamHandler) => {
        input.assert()
        const declaration = input.declarations.find((d) => d.name === name)
        if (!declaration) throw rpcError('CAPABILITY_DENIED')
        return this.register({
          ...input,
          declaration,
          handler,
          validateInput: compileExtensionSchema(declaration.inputSchema, 'E_SERVICE_DEF'),
        })
      },
    }
  }
  describe(owner: string, name: string) {
    const entry = this.entries.get(`${owner}/${name}`)
    if (!entry) throw rpcError('CAPABILITY_DENIED')
    const activationId = this.activations.require(owner, entry.integrity, undefined, entry.revision)
    const assertCurrent = () => {
      entry.signal.throwIfAborted()
      entry.assert()
      this.activations.require(owner, entry.integrity, activationId, entry.revision)
    }
    assertCurrent()
    return { ...entry, profileId: this.profileId, activationId, assertCurrent }
  }
}
