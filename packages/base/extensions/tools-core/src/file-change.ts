import { isUtf8 } from 'node:buffer'
import { createHash } from 'node:crypto'
import type { ToolContext } from '@agnes/extension-api'
import { normalizeWorkspacePath } from './paths.js'

export const REVIEW_TEXT_BYTES = 16 * 1024
export type FileChangeInput = {
  operation: 'write' | 'edit'
  path: string
  before: Uint8Array
  after: Uint8Array
  existed: boolean
}
export type FileChangeRecorder = (input: FileChangeInput, context: ToolContext) => Promise<void>
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Only a successful mutation supplies this receipt; the reader must still authorize the path. */
export function fileChangeReceipt(input: FileChangeInput, ctx: Pick<ToolContext, 'cwd' | 'session'>) {
  const turn = ctx.session.turn
  if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 1) return undefined
  if (input.path.includes('\\') || input.path.includes('\0')) return undefined
  const path = normalizeWorkspacePath(input.path, ctx.cwd)
  if (!path.inside || path.rel === '.' || path.rel.length > 4096) return undefined
  const text = input.before.length <= REVIEW_TEXT_BYTES && input.after.length <= REVIEW_TEXT_BYTES
  const binary = [input.before, input.after].some(
    (bytes) => !isUtf8(bytes) || bytes.subarray(0, 8192).includes(0),
  )
  const value = {
    version: 1,
    sessionId: ctx.session.key,
    toolUseId: ctx.session.toolUseId,
    turn,
    operation: input.operation,
    path: path.rel,
    existed: input.existed,
    beforeHash: hash(input.before),
    afterHash: hash(input.after),
    status: binary ? 'binary' : text ? 'available' : 'too-large',
    ...(!binary && text
      ? {
          before: Buffer.from(input.before).toString('utf8'),
          after: Buffer.from(input.after).toString('utf8'),
        }
      : {}),
  }
  // JSON escaping can exceed the event cap even when the raw UTF-8 fits.
  if (Buffer.byteLength(JSON.stringify(value)) > 60_000) {
    const { before, after, ...metadata } = value
    return { ...metadata, status: 'too-large' }
  }
  return value
}
