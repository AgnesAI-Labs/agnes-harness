---
name: finance-reconcile
description: Two CSV ledgers → exact-cent matching → mismatches and proposals → approval → simulated balanced entries.
---

# Finance reconciliation

Use unique IDs and exact integer cents. Flag missing, duplicate, date-mismatched and unequal evidence. Never infer unsupported matches. A human reviews drafts and account mappings before posting. Every entry must balance and a receipt must be verified. Customer adaptation: currency precision, keys, tolerances, account mapping and idempotent posting.

Use official present for generated deliverables under fde-output/finance-reconcile/. Declare the review using ui_render: a detail card, review steps, differences table, amount chart and adjustment form in both conversation and workbench. The 确认调整 action maps to fde_finance_approve through the generic deferred queue; keep backend tool authorization separate. Consume its original durable receipt through SC1 before ui_update marks processed rows. Reject edited amounts, duplicate ids and already processed transactions against the committed workflow evidence. If official Plan mode is active, submit the fixed workflow with exit_plan_mode and wait for its native approval before business steps. Plan approval never replaces a later business choice or tool permission.
