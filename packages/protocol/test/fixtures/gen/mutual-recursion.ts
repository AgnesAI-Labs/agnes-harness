// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'

export const MutualRecursion = Type.Module({
  "Node": Type.Object({ "id": Type.String(), "edges": Type.Array(Type.Ref('Edge')) }, { additionalProperties: false }),
  "Edge": Type.Object({ "to": Type.Ref('Node') }, { additionalProperties: false }),
})

export const Node = MutualRecursion.Import('Node')
export type Node = Static<typeof Node>
export const Edge = MutualRecursion.Import('Edge')
export type Edge = Static<typeof Edge>
