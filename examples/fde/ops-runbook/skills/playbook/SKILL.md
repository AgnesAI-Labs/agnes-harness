---
name: ops-runbook
description: Execute a reviewed runbook with approval and receipt verification.
---

# ops-runbook

Read the runbook and collect diagnostics first. Use only fixed author-approved argv through ToolContext.exec; the deployment selects the sandbox provider. A restart requires human approval even in the simulator. Verify the receipt. Stop after a failure or unknown result and investigate; do not blindly retry. Customer adaptation: replace argv with a bounded service allowlist and select an appropriate sandbox provider before startup.
