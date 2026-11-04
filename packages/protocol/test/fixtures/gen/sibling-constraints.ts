// generated from schema by tools/gen.ts — do not edit
import { Type, type Static, type TImport, type TModule, type TProperties } from '@sinclair/typebox'

export const SiblingConstraints = Type.Module({
  "ExtLikeType": Type.Union([Type.Union([Type.Literal('fixed')]), Type.String({ maxLength: 10, pattern: "^ok-.*$" })]),
})

export type SiblingConstraintsDefinitions = typeof SiblingConstraints extends TModule<TProperties, infer Definitions> ? Definitions : never

export const ExtLikeType: TImport<SiblingConstraintsDefinitions, 'ExtLikeType'> = SiblingConstraints.Import('ExtLikeType')
export type ExtLikeType = Static<typeof ExtLikeType>
