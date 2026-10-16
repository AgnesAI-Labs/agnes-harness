import type { StreamContext, StreamHandler } from '@agnes/extension-api'
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
  async forward(
    child: { owner: string; integrity: string; revision: string; packageId: string; assert(): void },
    owner: string,
    name: string,
    input: import('@agnes/protocol').JsonValue,
    context: StreamContext,
  ) {
    if (context.scope.kind !== 'profile' || context.scope.profileId !== this.profileId)
      throw rpcError('CAPABILITY_DENIED')
    const parent = this.describe(owner, name)
    if (!parent.declaration.producer || !parent.validateInput(input)) throw rpcError('CAPABILITY_DENIED')
    const activationId = this.activations.require(child.owner, child.integrity, undefined, child.revision)
    const assert = () => {
      context.signal.throwIfAborted()
      child.assert()
      this.activations.require(child.owner, child.integrity, activationId, child.revision)
      parent.assertCurrent()
    }
    assert()
    const signal = AbortSignal.any([context.signal, parent.signal])
    const close = () => context.stream.close('producer-revoked')
    signal.addEventListener('abort', close, { once: true })
    const guard = <T>(fn: () => T): T => {
      try {
        assert()
        return fn()
      } catch (error) {
        close()
        throw error
      }
    }
    try {
      await parent.handler(input, {
        ...context,
        signal,
        producer: {
          owner: child.owner,
          packageId: child.packageId,
          integrity: child.integrity,
          activationId,
        },
        stream: {
          ...context.stream,
          send: (frame) => guard(() => context.stream.send(frame)),
          onFrame: (fn) =>
            context.stream.onFrame((frame) => {
              try {
                guard(() => fn(frame))
              } catch {
                close()
              }
            }),
        },
      })
    } catch (error) {
      signal.removeEventListener('abort', close)
      close()
      throw error
    }
    context.stream.onDisconnect(() => signal.removeEventListener('abort', close))
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
