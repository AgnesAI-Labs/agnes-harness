import { type Static, Type } from '@sinclair/typebox'

const text = Type.String({ minLength: 1, maxLength: 1024 })
const strings = Type.Array(text, { maxItems: 4096 })
export const RuntimeAdminEmpty = Type.Object({}, { additionalProperties: false })
export const RuntimePublicationReport = Type.Object(
  {
    operation: Type.Union([
      Type.Literal('runtime-target'),
      Type.Literal('skills'),
      Type.Literal('models'),
      Type.Literal('extension-rows'),
    ]),
    ok: Type.Boolean(),
    recovery: Type.Literal('retry-same-input'),
    containers: Type.Array(
      Type.Object(
        { compositionHash: text, status: Type.Union([Type.Literal('applied'), Type.Literal('failed')]) },
        { additionalProperties: false },
      ),
      { maxItems: 4096 },
    ),
  },
  { additionalProperties: false },
)
export type RuntimePublicationReport = Static<typeof RuntimePublicationReport>
const enforcement = Type.Object(
  {
    level: Type.Union([Type.Literal('none'), Type.Literal('partial'), Type.Literal('full')]),
    scope: strings,
  },
  { additionalProperties: false },
)
export const RuntimeSecurityStatus = Type.Object(
  {
    platform: Type.Object(
      {
        os: text,
        l1: Type.Object(
          {
            level: Type.Union([Type.Literal('full'), Type.Literal('partial'), Type.Literal('unavailable')]),
            scope: strings,
            reason: Type.Optional(text),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    presetPolicies: Type.Array(
      Type.Object(
        {
          id: text,
          level: Type.Union([Type.Literal('L0'), Type.Literal('L1')]),
          required: Type.Boolean(),
          onUnavailable: Type.Union([Type.Literal('deny'), Type.Literal('allow')]),
          approvalPolicy: text,
          networkMode: Type.Union([
            Type.Literal('deny'),
            Type.Literal('allow-list'),
            Type.Literal('unrestricted'),
          ]),
        },
        { additionalProperties: false },
      ),
      { maxItems: 256 },
    ),
    workspaces: Type.Array(
      Type.Object(
        {
          sessionId: text,
          path: text,
          preset: text,
          provider: text,
          state: Type.Union([Type.Literal('ready'), Type.Literal('closing'), Type.Literal('unavailable')]),
          policyDigest: Type.Optional(text),
          enforcement: Type.Optional(enforcement),
        },
        { additionalProperties: false },
      ),
      { maxItems: 4096 },
    ),
  },
  { additionalProperties: false },
)
export type RuntimeSecurityStatus = Static<typeof RuntimeSecurityStatus>
/** Description-only catalog. No factories, preset config, credentials or source bytes. */
export const RuntimeAdminSnapshot = Type.Object(
  {
    providers: Type.Array(
      Type.Object(
        {
          kind: text,
          id: text,
          version: text,
          sourcePackage: text,
          capabilities: strings,
          restartRequired: Type.Boolean(),
          active: Type.Boolean(),
          selectedFor: strings,
          scope: Type.Optional(
            Type.Union([
              Type.Literal('session'),
              Type.Literal('generation'),
              Type.Literal('workspace'),
              Type.Literal('process'),
            ]),
          ),
        },
        { additionalProperties: false },
      ),
      { maxItems: 4096 },
    ),
    bundles: Type.Optional(
      Type.Array(Type.Object({ id: text, sourcePackage: text }, { additionalProperties: false }), {
        maxItems: 4096,
      }),
    ),
    presets: Type.Array(
      Type.Object({ id: text, isDefault: Type.Boolean() }, { additionalProperties: false }),
      { maxItems: 256 },
    ),
    localPluginFolders: Type.Object({ home: text, workspace: text }, { additionalProperties: false }),
    publication: Type.Optional(RuntimePublicationReport),
    security: Type.Optional(RuntimeSecurityStatus),
  },
  { additionalProperties: false },
)
export type RuntimeAdminSnapshot = Static<typeof RuntimeAdminSnapshot>

const engineText = Type.String({ maxLength: 4096, pattern: '^[^\u0000-\u001f\u007f]*$' })
const engineList = Type.Array(engineText, { maxItems: 64 })
const engineDocument = Type.Object(
  {
    enabled: Type.Boolean(),
    command: engineText,
    args: engineList,
    allow: engineList,
  },
  { additionalProperties: false },
)
const childEnginesDocument = Type.Object(
  {
    codex: engineDocument,
    claudeCode: engineDocument,
    sdk: Type.Object(
      {
        enabled: Type.Boolean(),
        protocol: Type.Union([Type.Literal('sdk'), Type.Literal('acp')]),
        command: engineText,
        args: engineList,
        allow: engineList,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)
/** Saved child-engine document. `effect` is a publication result, not an input. */
export const ChildEnginesSaveParams = Type.Object(
  {
    revision: Type.Integer({ minimum: 0, maximum: 9007199254740991 }),
    engines: childEnginesDocument,
  },
  { additionalProperties: false },
)
export type ChildEnginesSaveParams = Static<typeof ChildEnginesSaveParams>
export const ChildEnginesState = Type.Object(
  {
    revision: Type.Integer({ minimum: 0, maximum: 9007199254740991 }),
    engines: childEnginesDocument,
    effect: Type.Optional(Type.Union([Type.Literal('new-sessions'), Type.Literal('restart-required')])),
  },
  { additionalProperties: false },
)
export type ChildEnginesState = Static<typeof ChildEnginesState>
