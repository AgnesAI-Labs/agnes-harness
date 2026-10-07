---
name: device-inspection
description: Inspect a simulated device and verify constrained action receipts.
---

# device-inspection

Read the versioned state and compare temperature with the declared limit. Explain the anomaly; use only the constrained cooling action, target 20–30 degrees Celsius. Require human confirmation. dry_run defaults to true and must remain explicit when adapting. Read the action receipt and state to verify whether this was only a preview or a simulated effect. Unknown outcomes require manual inspection, never automatic replay. This is MHS-inspired and makes no MHS compatibility claim. Controllers retain interlocks, emergency stops and real-time safety.

Use official present for generated deliverables under fde-output/device-inspection/. Ask the business choice with official ask_user_question and wait for its validated answer before the action; keep backend tool authorization separate. If official Plan mode is active, submit the fixed workflow with exit_plan_mode and wait for its native approval before business steps. Plan approval never replaces a later business choice or tool permission.
