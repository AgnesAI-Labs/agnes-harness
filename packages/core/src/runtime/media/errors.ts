import type * as W from '@agnes/protocol/runtime'

export function refuse(
  code: W.RuntimeError['code'],
  detailCode: string,
  safeDetail?: W.JsonValue,
  owner?: W.OwnerRef,
): { ok: false; error: W.RuntimeError } {
  if (code === 'unknown_effect' && !owner) throw new TypeError('unknown_effect needs an owner')
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message: 'Media operation refused',
      diagnosticId: 'media-prepare',
      retryAdvice:
        owner && code === 'unknown_effect' ? { kind: 'reconcile', ownerRef: owner } : { kind: 'never' },
      ...(safeDetail === undefined ? {} : { safeDetail }),
    },
  }
}

/** Thrown inside the composite step and turned into one refusal at its boundary. */
export class MediaFault extends Error {
  constructor(
    readonly code: W.RuntimeError['code'],
    readonly detail: string,
    readonly safe?: W.JsonValue,
    readonly owner?: W.OwnerRef,
  ) {
    super(detail)
  }
}

export const faultOf = (error: unknown): { ok: false; error: W.RuntimeError } =>
  error instanceof MediaFault
    ? refuse(error.code, error.detail, error.safe, error.owner)
    : refuse('retryable', 'media_dependency_unavailable')
