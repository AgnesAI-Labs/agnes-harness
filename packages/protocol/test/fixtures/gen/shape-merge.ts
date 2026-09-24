// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'

export const ShapeMerge = Type.Module({
  "Extra": Type.Object({ "n": Type.Integer() }),
  "Shape": Type.Union([Type.Intersect([Type.Object({ "id": Type.String() }), Type.Intersect([Type.Object({ "kind": Type.Literal('circle') }), Type.Ref('Extra')])]), Type.Intersect([Type.Object({ "id": Type.String() }), Type.Object({ "kind": Type.Literal('square') })])]),
})

export const Extra = ShapeMerge.Import('Extra')
export type Extra = Static<typeof Extra>
export const Shape = ShapeMerge.Import('Shape')
export type Shape = Static<typeof Shape>
