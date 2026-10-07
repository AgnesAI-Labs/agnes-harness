---
name: finance-reconcile
description: Two CSV ledgers → exact-cent matching → mismatches and proposals → approval → simulated balanced entries.
---

# Finance reconciliation

Use unique IDs and exact integer cents. Flag missing, duplicate, date-mismatched and unequal evidence. Never infer unsupported matches. A human reviews drafts and account mappings before posting. Every entry must balance and a receipt must be verified. Customer adaptation: currency precision, keys, tolerances, account mapping and idempotent posting.

Use official present for generated deliverables under fde-output/finance-reconcile/. Ask the business choice with official ask_user_question and wait for its validated answer before the action; keep backend tool authorization separate. TODO: adopt official Plan mode when Stream E2 is available.
