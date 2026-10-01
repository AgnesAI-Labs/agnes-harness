// generated from schema/runtime by tools/gen-runtime.ts — do not edit
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
export const RuntimeArtifactPolicy = freeze({
  "maxTitleBytes": 1024,
  "maxMediaTypeBytes": 255,
  "uploadReservationTtlMs": 86400000,
  "downloadTicketTtlMs": 300000,
  "publicationFeature": "artifact-publication.v1",
  "ticketFeature": "artifact-ticket.v1",
  "descriptor": "ArtifactContentDescriptor",
  "reserve": {
    "contract": "agh.artifacts",
    "method": "reserve"
  },
  "publish": {
    "contract": "agh.artifacts",
    "method": "publish"
  },
  "uploadStates": [
    "uploading",
    "sealed",
    "aborted"
  ],
  "blobStates": [
    "staged",
    "pinned",
    "deleted"
  ],
  "publicationStates": [
    "reserved",
    "pending-publish",
    "ready",
    "failed",
    "revoked"
  ],
  "ticketRange": "open-ended",
  "ticketSingleUse": false
} as const)
export const RuntimeErrorDetails = freeze({
  "invalid_request": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "not_found": {
    "code": "invalid_input",
    "httpStatus": 404,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "range_not_satisfiable": {
    "code": "invalid_input",
    "httpStatus": 416,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "authentication_required": {
    "code": "denied",
    "httpStatus": 401,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "permission_denied": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "revoked": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "ticket_expired": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "blocked": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "operation_not_supported": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "unsupported": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "catalog_changed": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "retry_read"
    ]
  },
  "resync_required": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "retry_read"
    ]
  },
  "idempotency_conflict": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "revision_conflict": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "artifact_deleted": {
    "code": "invalid_input",
    "httpStatus": 410,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "artifact_bytes": {
    "code": "quota",
    "httpStatus": 413,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "rpc_json_bytes": {
    "code": "quota",
    "httpStatus": 413,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "inline_data_bytes": {
    "code": "quota",
    "httpStatus": 413,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "range_bytes": {
    "code": "quota",
    "httpStatus": 413,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "rate_limit": {
    "code": "quota",
    "httpStatus": 429,
    "retryAdviceKinds": [
      "retry_read"
    ]
  },
  "control_concurrency": {
    "code": "quota",
    "httpStatus": 429,
    "retryAdviceKinds": [
      "retry_read"
    ]
  },
  "cancelled": {
    "code": "cancelled",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "deadline_exceeded": {
    "code": "timeout",
    "httpStatus": 504,
    "retryAdviceKinds": [
      "retry_read",
      "retry_same_action"
    ]
  },
  "integrity": {
    "code": "internal",
    "httpStatus": 500,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "backend_unavailable": {
    "code": "retryable",
    "httpStatus": 503,
    "retryAdviceKinds": [
      "retry_read",
      "retry_same_action"
    ]
  },
  "effect_unknown": {
    "code": "unknown_effect",
    "httpStatus": 503,
    "retryAdviceKinds": [
      "reconcile"
    ]
  },
  "internal_error": {
    "code": "internal",
    "httpStatus": 500,
    "retryAdviceKinds": [
      "never"
    ]
  }
} as const)
export const RuntimeErrorHttpDefaults = freeze({
  "invalid_input": 400,
  "denied": 403,
  "incompatible": 409,
  "quota": 413,
  "cancelled": 409,
  "timeout": 504,
  "retryable": 503,
  "unknown_effect": 503,
  "conflict": 409,
  "internal": 500
} as const)
