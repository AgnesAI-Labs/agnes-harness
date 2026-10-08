import { type Static, Type } from '@sinclair/typebox'

/** Safe explanation records; no plugin config, credentials, factories or filesystem paths. */
export const CapabilitySource = Type.Object(
  {
    layer: Type.Union(
      (['default', 'profile', 'preset', 'admin', 'session'] as const).map((value) => Type.Literal(value)),
    ),
    name: Type.String(),
  },
  { additionalProperties: false },
)
export const CapabilityReason = Type.Object(
  { source: CapabilitySource, rule: Type.String() },
  { additionalProperties: false },
)
export const SessionCapability = Type.Object(
  {
    id: Type.String(),
    enabled: Type.Boolean(),
    reasons: Type.Array(CapabilityReason),
  },
  { additionalProperties: false },
)
const items = Type.Array(SessionCapability)
const loop = Type.Object({ id: Type.String(), version: Type.String() }, { additionalProperties: false })
const target = Type.Object({ route: Type.String(), model: Type.String() }, { additionalProperties: false })
const routes = Type.Intersect([Type.Record(Type.String(), target), Type.Object({ primary: target })])

/** Immutable Host snapshot: absent optional inspection data is supported during rollout. */
export const SessionCapabilitySet = Type.Object(
  {
    compositionHash: Type.Optional(Type.String()),
    preset: Type.String(),
    bundles: Type.Array(Type.String()),
    codePin: Type.Object(
      {
        generationId: Type.Optional(Type.String()),
        legacy: Type.Boolean(),
        packages: Type.Array(
          Type.Object(
            {
              id: Type.String(),
              version: Type.Optional(Type.String()),
              integrity: Type.Optional(Type.String()),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    loop: Type.Object({ value: loop, source: CapabilitySource }, { additionalProperties: false }),
    modelRoutes: Type.Object(
      { value: Type.Union([routes, Type.Null()]), source: CapabilitySource },
      { additionalProperties: false },
    ),
    permissions: Type.Object(
      {
        preset: Type.String(),
        policy: Type.String(),
        toolRuntime: Type.String(),
        readOnly: Type.Boolean(),
        approvalMode: Type.Optional(Type.String()),
        source: CapabilitySource,
      },
      { additionalProperties: false },
    ),
    sandbox: Type.Object(
      {
        provider: Type.String(),
        onUnavailable: Type.Union([Type.Literal('allow'), Type.Literal('deny')]),
        source: CapabilitySource,
      },
      { additionalProperties: false },
    ),
    compaction: Type.Object(
      { engine: Type.Union([Type.String(), Type.Null()]), source: CapabilitySource },
      { additionalProperties: false },
    ),
    persistence: Type.Object(
      { provider: Type.String(), source: CapabilitySource },
      { additionalProperties: false },
    ),
    tools: items,
    mcp: items,
    skills: items,
    modelAdapters: items,
    childEngines: items,
    childModels: items,
    uiModules: items,
    surfaces: items,
    packages: items,
    plugins: items,
    selectedModelAdapters: Type.Array(Type.String()),
  },
  { additionalProperties: false },
)

export const SessionCapabilityInfo = Type.Object(
  {
    sessionKey: Type.String(),
    generationId: Type.Optional(Type.String()),
    compositionHash: Type.String(),
    preset: Type.String(),
    bundles: Type.Array(Type.String()),
    capabilities: Type.Optional(SessionCapabilitySet),
    /** Compatibility adapter retained until clients adopt capabilities.tools and reasons. */
    toolGroups: Type.Optional(
      Type.Array(
        Type.Object(
          {
            packageId: Type.String(),
            reason: Type.Union(
              (['official-default', 'enabled-plugin', 'bundle', 'selected-loop'] as const).map((value) =>
                Type.Literal(value),
              ),
            ),
            bundles: Type.Array(Type.String()),
            tools: Type.Array(Type.String()),
          },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: true },
)
export const CompositionCapabilitySnapshot = Type.Object(
  {
    status: Type.Union([Type.Literal('live'), Type.Literal('desired')]),
    validation: Type.Literal('static'),
    capabilities: Type.Optional(SessionCapabilitySet),
    sessions: Type.Array(SessionCapabilityInfo),
  },
  { additionalProperties: true },
)

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T
export type CapabilitySource = Immutable<Static<typeof CapabilitySource>>
export type CapabilityReason = Immutable<Static<typeof CapabilityReason>>
export type SessionCapability = Immutable<Static<typeof SessionCapability>>
export type SessionCapabilitySet = Immutable<Static<typeof SessionCapabilitySet>>
export type SessionCapabilityInfo = Immutable<Static<typeof SessionCapabilityInfo>>
export type CompositionCapabilitySnapshot = Immutable<Static<typeof CompositionCapabilitySnapshot>>
