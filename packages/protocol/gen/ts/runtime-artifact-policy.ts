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
  },
  "action_count": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "action_input": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "action_revision": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "admission_absence_unproven": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "admission_cancelled": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "approval_ask": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "approval_ask_exists": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "approval_ask_source": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "approval_authentication": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "approval_control": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "approval_expired": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "approval_policy_source": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "approval_preparation": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "approval_responder": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "approval_response": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "approval_scope": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "attempt_exists": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "attempt_revision": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "attempt_settled": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "attempt_state": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "child_key_duplicate": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "claim_epoch": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "command_payload_mismatch": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "complete_children": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "complete_new_actions": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "complete_pending": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "complete_unknown": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "composite_target": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "continuation": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "continuation_codec": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "detached_owner_missing": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "effects_action_state": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "effects_dispatch_source": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "effects_run_cancelled": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "effects_stage_source_unavailable": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "epoch_overflow": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "expired": {
    "code": "timeout",
    "httpStatus": 504,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "external_request": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "fail_new_actions": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "fault": {
    "code": "internal",
    "httpStatus": 500,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "input_digest": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "intent_fingerprint": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "interaction_absent": {
    "code": "invalid_input",
    "httpStatus": 404,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "interaction_current": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "interaction_cursor": {
    "code": "internal",
    "httpStatus": 500,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "interaction_cut": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "interaction_id": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "interaction_limit": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "interaction_owner": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "interaction_pending": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "interaction_reader": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "interaction_scope": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "interaction_source": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "interaction_unavailable": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "invalid_verifier": {
    "code": "internal",
    "httpStatus": 500,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "invocation_absent": {
    "code": "invalid_input",
    "httpStatus": 404,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "invocation_exists": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "invocation_state": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "invocation_target": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "lease_timing": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "legacy_profile": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_action_deadline": {
    "code": "timeout",
    "httpStatus": 504,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_already_terminal": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_binding_not_selected": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_cancelled": {
    "code": "cancelled",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_catalog_digest": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_catalog_mismatch": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_cleanup_unavailable": {
    "code": "unknown_effect",
    "httpStatus": 503,
    "retryAdviceKinds": [
      "reconcile"
    ]
  },
  "loop_codec_mismatch": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_cold_state_consumer_unavailable": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_config_invalid": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_context_digest": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_context_identity": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_context_mismatch": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_context_preparation_unavailable": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_context_refresh_unavailable": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_context_snapshot": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_context_source_identity": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_continuation_invalid": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_conversation_codec_unavailable": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_credential_binding": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_credential_expired": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_data_integrity": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_data_schema": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_dependency_binding": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_dependency_missing": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_dependency_unavailable": {
    "code": "internal",
    "httpStatus": 500,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_descriptor_invalid": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_disposed": {
    "code": "cancelled",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_extra_tool_call": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_feature_unavailable": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_final_output_incomplete": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_frame_identity": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_inline_limit": {
    "code": "quota",
    "httpStatus": 413,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_invocation_expired": {
    "code": "timeout",
    "httpStatus": 504,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_json_limit": {
    "code": "quota",
    "httpStatus": 413,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_method_unavailable": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_methods_invalid": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_model_action_unavailable": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_model_content_invalid": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_model_credentials_unavailable": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_model_output_invalid": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_not_ready": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_owner_unavailable": {
    "code": "internal",
    "httpStatus": 500,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_pending_fingerprint": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_pending_identity": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_pending_receipt_invalid": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_policy_identity": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_policy_invalid": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_policy_mismatch": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_prepared_action_invalid": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_prepared_action_substituted": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_prepared_identity": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_prepared_mismatch": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_pure_tool_required": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_receipt_identity": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_receipt_invalid": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_receipt_unavailable": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_request_conflict": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_result_missing": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_resume_identity": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_route_mismatch": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_run_provider_unavailable": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_run_resolution_unavailable": {
    "code": "unknown_effect",
    "httpStatus": 503,
    "retryAdviceKinds": [
      "reconcile"
    ]
  },
  "loop_run_source_mismatch": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_scope_invalid": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_single_tool_required": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_source_invalid": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_source_snapshot": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_source_unavailable": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_start_identity": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_state_frame_mismatch": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_state_identity": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_state_invalid": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_state_pending": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_state_producer": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_state_references": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_state_transactions_unavailable": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_supervisor_frame_mismatch": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_supervisor_unavailable": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_tool_call_invalid": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_tool_not_in_catalog": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_tool_result_unsupported": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_tools_action_unavailable": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "loop_transition_invalid": {
    "code": "internal",
    "httpStatus": 500,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_anchor_unsupported": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_binding_denied": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_continuation_conflict": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_conversion_depth": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_conversion_not_needed": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_conversion_unavailable": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_conversion_unknown": {
    "code": "unknown_effect",
    "httpStatus": 503,
    "retryAdviceKinds": [
      "reconcile"
    ]
  },
  "media_dependency_unavailable": {
    "code": "retryable",
    "httpStatus": 503,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_derived_too_large": {
    "code": "quota",
    "httpStatus": 413,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_image_invalid": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_image_limit": {
    "code": "quota",
    "httpStatus": 413,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_image_resize_required": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_kind_unsupported": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_native_unavailable": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_no_route": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_plan_unsupported_transform": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_prepare_failed": {
    "code": "internal",
    "httpStatus": 500,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_result_unavailable": {
    "code": "retryable",
    "httpStatus": 503,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_route_drift": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_source_denied": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_source_drift": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_source_kind": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_source_unavailable": {
    "code": "retryable",
    "httpStatus": 503,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_verify_chain": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_verify_manifest": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_verify_receipt": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "media_verify_schema": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_adapter_unavailable": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_binding_denied": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_cancelled": {
    "code": "cancelled",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_catalog_missing": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_child_bridge_not_ready": {
    "code": "internal",
    "httpStatus": 500,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_child_unknown": {
    "code": "unknown_effect",
    "httpStatus": 503,
    "retryAdviceKinds": [
      "reconcile"
    ]
  },
  "model_continuation_conflict": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_credential_binding": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_credential_expired": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_credential_required": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_credential_unavailable": {
    "code": "internal",
    "httpStatus": 500,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_credential_unverified": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_current": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_dependency_unavailable": {
    "code": "retryable",
    "httpStatus": 503,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_egress_binding": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_egress_cancelled": {
    "code": "cancelled",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_egress_closed": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_egress_credential": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_egress_dns": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_egress_headers": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_egress_limits": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_egress_missing": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_egress_network": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_egress_owner": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_egress_redirect": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_egress_replay": {
    "code": "unknown_effect",
    "httpStatus": 503,
    "retryAdviceKinds": [
      "reconcile"
    ]
  },
  "model_egress_response": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_egress_target": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_egress_unavailable": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_egress_unknown": {
    "code": "unknown_effect",
    "httpStatus": 503,
    "retryAdviceKinds": [
      "reconcile"
    ]
  },
  "model_feature_mismatch": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_gateway_unavailable": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_hooks_unsupported": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_in_flight": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_infer_input": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_input": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_input_schema": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_not_ready": {
    "code": "internal",
    "httpStatus": 500,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_output_budget": {
    "code": "quota",
    "httpStatus": 413,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_prepared_lost": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_prepared_mismatch": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_prepared_source": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_prepared_too_large": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_prepared_unknown": {
    "code": "unknown_effect",
    "httpStatus": 503,
    "retryAdviceKinds": [
      "reconcile"
    ]
  },
  "model_price_mismatch": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_receipt_unconfirmed": {
    "code": "unknown_effect",
    "httpStatus": 503,
    "retryAdviceKinds": [
      "reconcile"
    ]
  },
  "model_reconcile_result": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_refresh_unsupported": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_result": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_scope": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_selection_credential": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_selection_features": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_selection_not_ready": {
    "code": "internal",
    "httpStatus": 500,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_selection_route": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_selection_slot": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_selection_thinking": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_source": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_source_drift": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_source_frame": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_source_media": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_source_price": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_source_ref": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_source_slot": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_source_stale": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_source_unavailable": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_stream_unknown": {
    "code": "unknown_effect",
    "httpStatus": 503,
    "retryAdviceKinds": [
      "reconcile"
    ]
  },
  "model_target_changed": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_usage_attribution": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_usage_schema": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_wire_empty": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_wire_item": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_wire_media": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_wire_media_anchor": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_wire_media_feature": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_wire_output_schema": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_wire_overrides": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_wire_schema": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_wire_seed": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_wire_tool_description": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_wire_tool_feature": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_wire_tool_format": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_wire_tool_history": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_wire_tool_id": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_wire_tool_name": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_wire_tool_pair": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_wire_tool_schema": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_wire_tool_schema_recursive": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_wire_tool_thinking": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_wire_tools": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "model_wire_tools_oversize": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "native_read": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "obligation": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "provider_exists": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "provider_state": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "query_owner": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "quota_amount": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "read_guard": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "receipt_conflict": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "receipt_intake": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "reference_duplicate": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "request_digest": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "response_id": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "retention_source": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "revision_overflow": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "run_cancelled": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "run_closing": {
    "code": "cancelled",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "run_exists": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "run_state": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "run_target": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "seq_mismatch": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "session_absent": {
    "code": "invalid_input",
    "httpStatus": 404,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "session_control_active_run": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "session_control_command": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "session_control_permission": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "session_control_preset": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "session_control_request": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "session_control_revision": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "session_control_schema": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "session_workspace": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "signal_absent": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "signal_consumed": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "signal_duplicate": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "state_cancelled": {
    "code": "cancelled",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "state_collection": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "state_integrity": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "state_item_oversize": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "state_legacy_version": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "state_loop_binding": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "state_meta_unproven": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "state_method": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "state_owner": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "state_request": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "state_scope": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "state_session_parent": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "state_snapshot": {
    "code": "denied",
    "httpStatus": 403,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "state_type": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "state_unavailable": {
    "code": "internal",
    "httpStatus": 500,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "ttl": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "unknown_reader": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "unknown_schema": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "unproven_approval_ask": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "unproven_approval_policy": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "unproven_history": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "unproven_source": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "unsupported_session_control_command": {
    "code": "incompatible",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "usage_source": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "wait_action_unknown": {
    "code": "invalid_input",
    "httpStatus": 400,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "wait_not_satisfied": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "wait_state": {
    "code": "conflict",
    "httpStatus": 409,
    "retryAdviceKinds": [
      "never"
    ]
  },
  "writer_lease": {
    "code": "conflict",
    "httpStatus": 409,
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
