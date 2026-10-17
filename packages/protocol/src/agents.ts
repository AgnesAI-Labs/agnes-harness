import { type Static, Type } from '@sinclair/typebox'
import { BundleLaunch as LaunchSchema } from '../gen/ts/extension-manifest.js'

const BundleLaunch = Type.Module({
  PluginLocalizedText: LaunchSchema.$defs.PluginLocalizedText,
  BundleLaunch: LaunchSchema.$defs.BundleLaunch,
}).Import('BundleLaunch')

const text = Type.String({ minLength: 1, maxLength: 512 })
const target = Type.Object({ route: text, model: text }, { additionalProperties: false })
export const AgentResolveParams = Type.Object({ ref: text }, { additionalProperties: false })
/** A backend-reviewed selection. The digest also covers private effective configuration. */
export const AgentPlan = Type.Object(
  {
    ref: text,
    launch: BundleLaunch,
    loop: Type.Object({ id: text, version: text }, { additionalProperties: false }),
    bundles: Type.Array(text, { maxItems: 64 }),
    preset: text,
    pages: Type.Array(text, { maxItems: 64 }),
    digest: text,
    compositionHash: text,
    presetHash: text,
    effectivePresetHash: text,
    model: target,
    models: Type.Record(Type.String(), target),
    permission: Type.Object(
      {
        readOnly: Type.Boolean(),
        tools: Type.Array(text),
        allow: Type.Array(text),
        deny: Type.Array(text),
      },
      { additionalProperties: false },
    ),
    sources: Type.Array(
      Type.Object(
        {
          id: text,
          version: text,
          integrity: text,
          source: text,
          capabilityHash: Type.Optional(text),
          treeIntegrity: Type.Optional(text),
          snapshotId: Type.Optional(text),
        },
        { additionalProperties: false },
      ),
      { maxItems: 512 },
    ),
  },
  { additionalProperties: false },
)
export type AgentPlan = Static<typeof AgentPlan>
export type AgentResolveParams = Static<typeof AgentResolveParams>
