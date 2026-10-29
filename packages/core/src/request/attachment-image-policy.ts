import type { AttachmentImagePolicy } from '@agnes/extension-api'
import { userImagePolicy } from '@agnes/protocol'
import { USER_MESSAGE_IMAGE_LIMITS } from '@agnes/protocol-validation'
import { resolveModel } from '../step/inference.js'
import { resolvedModelRecord } from '../step/model-tools.js'
import type { SessionImpl } from '../step/session.js'

export function attachmentImagePolicy(session: SessionImpl): AttachmentImagePolicy {
  const target = resolveModel(session, 'primary')
  const policy = userImagePolicy(resolvedModelRecord(session.d.provider, target))
  return {
    maxWidth: Math.floor(policy.maxWidth),
    maxHeight: Math.floor(policy.maxHeight),
    maxBytes: Math.min(
      USER_MESSAGE_IMAGE_LIMITS.maxBytesPerImage,
      Math.floor((policy.maxBase64Bytes ?? USER_MESSAGE_IMAGE_LIMITS.maxBytesPerImage) / 4) * 3,
    ),
    jpegQuality: Math.floor(policy.jpegQuality ?? 85),
  }
}
