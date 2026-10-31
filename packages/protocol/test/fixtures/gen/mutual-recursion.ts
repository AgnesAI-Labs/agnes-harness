// generated from schema by tools/gen.ts — do not edit
import { Type, type Static, type TImport, type TModule, type TProperties } from '@sinclair/typebox'

export const MutualRecursion = Type.Module({
  "Node": Type.Object({ "id": Type.String(), "edges": Type.Array(Type.Ref('Edge')) }, { additionalProperties: false }),
  "Edge": Type.Object({ "to": Type.Ref('Node') }, { additionalProperties: false }),
})

export type MutualRecursionDefinitions = typeof MutualRecursion extends TModule<TProperties, infer Definitions> ? Definitions : never

export const Node: TImport<MutualRecursionDefinitions, 'Node'> = MutualRecursion.Import('Node')
export type Node = Static<typeof Node>
export const Edge: TImport<MutualRecursionDefinitions, 'Edge'> = MutualRecursion.Import('Edge')
export type Edge = Static<typeof Edge>
