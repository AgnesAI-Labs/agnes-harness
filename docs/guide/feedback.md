# Feedback and reviewed Skill growth

English | [简体中文](feedback.zh-CN.md)

Rate a completed assistant message with the **Thumbs up** or **Thumbs down** icon. Message feedback controls appear on hover or keyboard focus on desktop and remain visible on touch widths; their tooltips and accessible labels describe each action. Expand **Feedback note** to add an optional category and note, then save. Use the **Session feedback** workbench panel for the whole session. You can edit your feedback or withdraw it; withdrawal preserves the earlier ledger facts and does not remove an already reviewed Skill.

Feedback stays in this installation. It is excluded from observability, does not enter ordinary model history, and never authorizes log uploads. The native session export includes feedback revisions and growth links, subject to its normal privacy redaction. Withdrawal is a tombstone rather than physical erasure.

For a negative message rating, or a positive rating categorized **Do this again**, choose **Generate improvement suggestion**. Save any note edits first. This makes an independent, bounded request to the session's configured local model, using the feedback and the completed turn's message/tool evidence. The official service requires an HTTP(S) endpoint on `127.0.0.1` or `[::1]`; a remote model is refused before inference. Configure a local model before generating suggestions.

The model drafts one new Skill package. It cannot execute tools, write memory, or publish a package through this operation. The platform constructs a fixed registration wrapper and a registration test around the drafted text. Open **Settings → Plugins → Candidates** to inspect the full files, explicitly run candidate tests, submit the exact passing hash for review, and approve or reject it. Approval publishes the reviewed snapshot through the existing candidate flow; generation alone never installs, trusts, enables or applies it. Test execution runs candidate code and retains the existing confirmation step.

Use **Execution evidence** on the rated message to see the feedback revision, turn/message references, candidate, review decision and published version. Refresh the provenance view after a review decision. If candidate evidence is missing or its origin cannot be verified, the chain shows it as unavailable; the feedback itself remains readable. Editing a candidate invalidates its tests and review according to the [candidate contract](../extend/agent-built-plugins.md).

**Settings → Feedback** lists feedback from sessions owned by the authenticated local administrator, including cold history. Filter by session ID, category, rating or presence of a candidate. Counts reflect the filtered rows: positive/negative counts exclude withdrawn items, while withdrawn and candidate counts include their retained tombstones. The view is bounded to 256 sessions and 4096 current items/growth links; partial aggregate reads are marked. Oversized per-session evidence is refused. Reopen a saved session before editing or generating feedback for it.

The replaceable public service is described in [Feedback services](../extend/feedback.md). Learned memory retains its separate [memory approval policy](memory.md).
