---
name: ops-runbook
description: Execute a reviewed runbook with approval and receipt verification.
---

# ops-runbook

Read the runbook and collect diagnostics first. Use only fixed author-approved argv through ToolContext.exec; the deployment selects the sandbox provider. A restart requires human approval even in the simulator. Verify the receipt. Stop after a failure or unknown result and investigate; do not blindly retry. Customer adaptation: replace argv with a bounded service allowlist and select an appropriate sandbox provider before startup.

Use official present for generated deliverables under fde-output/ops-runbook/. Ask the business choice with official ask_user_question and wait for its validated answer before the action; keep backend tool authorization separate. If official Plan mode is active, submit the fixed workflow with exit_plan_mode and wait for its native approval before business steps. Plan approval never replaces a later business choice or tool permission.
