# Deliverables

`present` registers existing readable files as session artifacts, emits a durable event and automatically opens an `artifact-file` Intelligent UI surface. Do not call `ui_render` again for the same presentation. Web downloads through the existing artifact RPC; references are authorized for the exact session/lane and verified before opening. See [default tools](../../../../docs/reference/default-tools.md) for inputs and limits.

The projection retains recent registrations within its byte ceiling; history remains in the ledger. It does not bypass file policy, create workspace files, or expose raw host paths as browser URLs.
