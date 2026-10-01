import {
  defineGeneratedAuthorSchema,
  defineTool,
  type GeneratedAuthorSchemaSource,
} from '@agnes/extension-api/runtime'
import { MessageSchema, type MessageValue } from './generated/owned-schema/Message.js'

export const declared = defineTool({
  id: 'message',
  description: 'Read generated message',
  execution: 'pure',
  input: MessageSchema,
  execute(value) {
    return { content: [], structured: { message: value.message } }
  },
})
export const valid: MessageValue = { message: 'hello', labels: ['one'] }
MessageSchema.encode(valid)
// @ts-expect-error Generated property types reject incorrect payloads.
MessageSchema.encode({ message: 1 })
// @ts-expect-error Generated object properties are immutable.
valid.message = 'changed'
// @ts-expect-error Generated arrays are immutable.
valid.labels?.push('changed')
declare const source: GeneratedAuthorSchemaSource
// @ts-expect-error Sources cannot supply parser callbacks.
defineGeneratedAuthorSchema({ ...source, parse: () => 'forged' })
// @ts-expect-error Sources cannot supply digest authority.
defineGeneratedAuthorSchema({ ...source, digest: '0'.repeat(64) })

import { defineGeneratedAuthorSchema as GeneratedCollisionSchema } from './generated/owned-schema/defineGeneratedAuthor.js'
export const collisionEncoding = GeneratedCollisionSchema.encode({ message: 'valid collision name' })
