import { inspectJsonData, UI_SLOT_MAX_BYTES } from '@agnes/protocol'
export const SLOT_PAYLOAD_MAX_BYTES = UI_SLOT_MAX_BYTES

export function isJsonPayload(
  value: unknown,
  maxBytes = SLOT_PAYLOAD_MAX_BYTES,
): { ok: true; bytes: number } | { ok: false; reason: string } {
  const result = inspectJsonData(value, maxBytes)
  return result.ok ? { ok: true, bytes: result.bytes } : result
}
