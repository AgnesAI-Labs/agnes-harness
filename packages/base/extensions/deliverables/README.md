# Deliverables

`present` registers existing readable files as session artifacts, emits a durable event and automatically opens an `artifact-file` Intelligent UI surface. Do not call `ui_render` again for the same presentation. Web downloads through the existing artifact RPC; references are authorized for the exact session/lane and verified before opening. See [default tools](../../../../docs/reference/default-tools.md) for inputs and limits.

New registrations retain the source file's final extension in both display and download names. A custom name `City guide` for `cities.html` becomes `City guide.html`; an existing matching extension is preserved case-insensitively. A different extension is retained as part of the label and the source extension is appended (`City guide.pdf.html`). Names are limited to 256 characters by shortening the stem, preserving the suffix. Sources without an extension stay unchanged. The workspace file is never renamed, and existing recorded registrations keep their original names.

The projection retains recent registrations within its byte ceiling; history remains in the ledger. It does not bypass file policy, create workspace files, or expose raw host paths as browser URLs.

The official file cards, turn tails, same-name history and workbench panel are supplied by the default `@agnes/deliverables-ui` browser plugin. A profile-lifetime community plugin can take over the `deliverables` presentation role through `ctx.presentationRoles`, and disposal restores the default. See `examples/community/deliverables-gallery`.

Intelligent UI is an explicitly declared optional peer. `present` first persists immutable artifact references and its event, then attempts the UI enhancement. An unavailable renderer never fails an already recorded delivery. Its durable `structured` result contains `deliverables`, `laneId` and `owner`, allowing a plain file list without Intelligent UI. Editing a workspace source does not alter a delivered snapshot.
