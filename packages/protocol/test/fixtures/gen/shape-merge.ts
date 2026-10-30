// generated from schema by tools/gen.ts — do not edit
import { Type, type Static, type TImport, type TModule, type TProperties } from '@sinclair/typebox'

export const ShapeMerge = Type.Module({
  "Extra": Type.Object({ "n": Type.Integer() }),
  "Shape": Type.Union([Type.Intersect([Type.Object({ "id": Type.String() }), Type.Intersect([Type.Object({ "kind": Type.Literal('circle') }), Type.Ref('Extra')])]), Type.Intersect([Type.Object({ "id": Type.String() }), Type.Object({ "kind": Type.Literal('square') })])]),
})

export type ShapeMergeDefinitions = typeof ShapeMerge extends TModule<TProperties, infer Definitions> ? Definitions : never

export const Extra: TImport<ShapeMergeDefinitions, 'Extra'> = ShapeMerge.Import('Extra')
export type Extra = Static<typeof Extra>
export const Shape: TImport<ShapeMergeDefinitions, 'Shape'> = ShapeMerge.Import('Shape')
export type Shape = Static<typeof Shape>
