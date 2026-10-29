import { type PublicErrorCode, publicErrorCode, publicErrorReason } from '@agnes/protocol'

/** Retain the public identity at capture time; exception text is diagnostic, never an identifier. */
export type GenerationFailure = Readonly<{
  code: PublicErrorCode | 'E_GENERATION'
  message: string
  reason?: string
}>

export function generationFailure(
  error: unknown,
  fallback: GenerationFailure['code'] = 'E_GENERATION',
): GenerationFailure {
  const code = publicErrorCode(error) ?? fallback
  const reason = publicErrorReason(error)
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    ...(reason ? { reason } : {}),
  }
}

/** Generation-owned public refusals carry their identifier before entering any catch boundary. */
export function generationError(code: PublicErrorCode, message: string, options?: ErrorOptions) {
  return Object.assign(new Error(`${code}: ${message}`, options), { code })
}
