// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'

export const SiblingConstraints = Type.Module({
  "ExtLikeType": Type.Union([Type.Union([Type.Literal('fixed')]), Type.String({ maxLength: 10, pattern: "^ok-.*$" })]),
})

export const ExtLikeType = SiblingConstraints.Import('ExtLikeType')
export type ExtLikeType = Static<typeof ExtLikeType>
