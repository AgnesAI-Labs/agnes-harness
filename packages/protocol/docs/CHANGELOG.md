# Protocol changes

## Unreleased

- `_agnes/v1/session.view` (client tier): reads a session's recorded conversation without opening it, so a session this build cannot continue (newer or older version, missing pinned provider, damaged ledger) stays viewable. Adds `SessionViewParams`, `SessionViewResult` and `SessionViewNotice`. Nothing is restored, locked or written; a damaged ledger returns the rows that decoded safely plus a `notice`.
- `_agnes/v1/sessions.migrate`: optional `repin` (pinned seam kinds the administrator agrees to replace) on the params and optional `repinned` on the result. A migration that would replace a pinned seam implementation without naming it fails with `E_SEAM_PIN_CHANGE`.
- App Server error causes `E_SESSION_VERSION_NEWER`, `E_SESSION_VERSION_OLDER`, `E_SESSION_CORRUPT`, `E_SEAM_PIN_MISMATCH`, `E_SEAM_PIN_CHANGE` and message keys `appServer.errors.sessionNewer`, `sessionOlder`, `sessionCorrupt`. `sessionVersionNotice()` gives the bilingual text and the follow-up actions.
- Profile and lockfile `seams`: the seven seam kinds are `{ provider, version? }` (`SeamSelection`); `seams.ledger` is `seams.billing`, `seams.harness` is gone.
- `RuntimeAdminSnapshot.providers[]`: `required` and `pinned`.
- `approvals.mode` loses `smart`; the `approval/guardian-decided` event is removed.
