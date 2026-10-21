import { type Static, Type } from '@sinclair/typebox'
import { SessionIntegrityStatus } from './session-integrity.js'

const text = Type.String({ minLength: 1, maxLength: 1024 })
const hash = Type.String({ minLength: 1, maxLength: 256 })
/** When a changed selection reaches this session. `migrate` needs an explicit administrator action. */
const effect = Type.Union([
  Type.Literal('new-sessions'),
  Type.Literal('restart-required'),
  Type.Literal('migrate'),
])
const pending = Type.Object(
  { id: text, version: Type.Optional(text), effect },
  { additionalProperties: false },
)

export const SessionRuntimeParams = Type.Object({ sessionId: text }, { additionalProperties: false })

/**
 * What a session is actually running, produced by the Host's instance and generation management.
 * Description only: no plugin configuration, credentials, factories or filesystem paths.
 */
export const SessionRuntimeDescriptor = Type.Object(
  {
    sessionKey: text,
    integrity: Type.Optional(SessionIntegrityStatus),
    /**
     * False for a session no container has open: the descriptor then carries only what its durable pin and
     * composition record say, and the sections that need a live container (`providers`, `resources`,
     * `policy`) are absent rather than guessed from today's configuration.
     */
    loaded: Type.Boolean(),
    generation: Type.Object(
      {
        /** Absent for a deployment without generation pins; such a session is always current. */
        id: Type.Optional(text),
        current: Type.Boolean(),
        state: Type.Union([
          Type.Literal('active'),
          Type.Literal('draining'),
          Type.Literal('historical'),
          Type.Literal('failed'),
        ]),
        /** Present when a newer code generation exists than the one this session is pinned to. */
        newer: Type.Optional(Type.Object({ id: text, effect }, { additionalProperties: false })),
      },
      { additionalProperties: false },
    ),
    composition: Type.Optional(Type.Object({ hash }, { additionalProperties: false })),
    preset: Type.Optional(
      Type.Object(
        { name: text, bundles: Type.Array(text, { maxItems: 64 }) },
        { additionalProperties: false },
      ),
    ),
    loop: Type.Optional(Type.Object({ id: text, version: text }, { additionalProperties: false })),
    /** Selected provider per kind for this session. `pending` appears when the configured one differs. */
    providers: Type.Array(
      Type.Object(
        {
          kind: text,
          id: text,
          version: Type.Optional(text),
          sourcePackage: Type.Optional(text),
          scope: Type.Optional(
            Type.Union([
              Type.Literal('session'),
              Type.Literal('generation'),
              Type.Literal('workspace'),
              Type.Literal('process'),
            ]),
          ),
          binding: Type.Union([
            Type.Literal('session-pinned'),
            Type.Literal('generation'),
            Type.Literal('process'),
          ]),
          pending: Type.Optional(pending),
        },
        { additionalProperties: false },
      ),
      { maxItems: 256 },
    ),
    /** Seam bindings. `pinned` is true once the session keeps its own binding across generations. */
    seams: Type.Array(
      Type.Object(
        {
          kind: text,
          provider: text,
          version: Type.Optional(text),
          pinned: Type.Boolean(),
          pending: Type.Optional(pending),
        },
        { additionalProperties: false },
      ),
      { maxItems: 64 },
    ),
    resources: Type.Optional(
      Type.Object(
        {
          profileHash: hash,
          /** Fingerprint of the model route table the session's container is running. */
          modelRevision: Type.Optional(hash),
          generationDigest: Type.Optional(hash),
          /** Live resource consumers (skills, MCP servers) and the revision each one serves. */
          items: Type.Array(
            Type.Object(
              {
                id: text,
                resources: Type.Array(text, { maxItems: 16 }),
                revision: Type.Optional(hash),
              },
              { additionalProperties: false },
            ),
            { maxItems: 1024 },
          ),
        },
        { additionalProperties: false },
      ),
    ),
    policy: Type.Optional(
      Type.Object(
        {
          approvalMode: Type.Optional(text),
          /** Effective backend permission after the user's session switch, separate from declared policy. */
          permission: Type.Optional(
            Type.Object({ policy: Type.String(), principal: text }, { additionalProperties: false }),
          ),
          toolPolicy: text,
          toolRuntime: text,
          readOnly: Type.Boolean(),
          sandbox: Type.Object(
            {
              provider: text,
              onUnavailable: Type.Union([
                Type.Literal('allow'),
                Type.Literal('deny'),
                Type.Literal('allow-if-unimplemented'),
              ]),
              policyDigest: Type.Optional(text),
              enforcement: Type.Optional(
                Type.Object(
                  {
                    level: Type.Union([Type.Literal('none'), Type.Literal('partial'), Type.Literal('full')]),
                    scope: Type.Array(text, { maxItems: 64 }),
                  },
                  { additionalProperties: false },
                ),
              ),
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
    ),
    /** Inputs whose change was refused or cannot reach the running process without a restart. */
    restartRequired: Type.Array(text, { maxItems: 64 }),
  },
  { additionalProperties: false },
)
export type SessionRuntimeParams = Static<typeof SessionRuntimeParams>
export type SessionRuntimeDescriptor = Static<typeof SessionRuntimeDescriptor>
