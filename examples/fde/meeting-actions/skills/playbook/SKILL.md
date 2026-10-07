---
name: meeting-actions
description: Transcript → summary, decisions, owners/dates → markdown export and panel → approval → simulated send.
---

# Meeting actions

Preserve explicit summary, decisions and actions with owners, ISO dates and source lines. Never invent assignments. Export markdown before proposing send. Human approval and a verified receipt establish delivery. Customer adaptation: transcript validation, calendar rules, recipients and idempotent delivery.

Use official present for generated deliverables under fde-output/meeting-actions/. Ask the business choice with official ask_user_question and wait for its validated answer before the action; keep backend tool authorization separate. If official Plan mode is active, submit the fixed workflow with exit_plan_mode and wait for its native approval before business steps. Plan approval never replaces a later business choice or tool permission.
