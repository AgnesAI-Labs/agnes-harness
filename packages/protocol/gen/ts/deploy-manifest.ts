// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'

export const DeployManifestSchema = Type.Module({
  "DeployManifest": Type.Object({ "id": Type.String({ pattern: "^[a-z0-9-]{1,64}$" }), "version": Type.String({ maxLength: 64 }), "harnessRange": Type.String({ maxLength: 64 }), "extensions": Type.Array(Type.Object({ "path": Type.String({ pattern: "^extensions/" }), "id": Type.String({ pattern: "^[a-z0-9-]+/[a-z0-9-]+$" }) }, { additionalProperties: false })), "profileFragment": Type.String({ pattern: "^profile/" }), "presets": Type.Array(Type.String({ pattern: "^preset/" })), "fixtures": Type.String({ pattern: "^fixtures/" }), "surfaces": Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80, pattern: "^surfaces/[a-z][a-z0-9-]{0,63}\\.json$" }), { maxItems: 64, uniqueItems: true })) }, { additionalProperties: false }),
})

export const DeployManifest = DeployManifestSchema.Import('DeployManifest')
export type DeployManifest = Static<typeof DeployManifest>
export const Root = DeployManifest
export type Root = DeployManifest
