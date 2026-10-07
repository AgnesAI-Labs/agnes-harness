# Persistent goals

Official default agnes/goal uses only @agnes/extension-api registrations. Goal state, human controls, costs, model status updates, and round reservations rebuild from the session ledger. There is no workspace goal file.

Use the Web goal card or these commands in Web/CLI:

```text
/goal create --max-rounds 10 --budget 20 Deliver and validate a patch
/goal edit --max-rounds 5 Deliver a smaller patch
/goal edit --budget none Deliver without a goal credit cap
/goal pause
/goal resume
/goal complete
/goal clear
```

/goal followed by an objective also creates a goal. Defaults are ten automatic rounds and no additional credit limit. Options precede the objective. Editing preserves spend and phase. Resume explicitly authorizes a fresh round allowance and preserves credit spend. A completed goal must be cleared or replaced before resuming.

The model has goal_get {} and goal_update {status:"complete"|"blocked", reason:"..."}. It cannot create, edit, pause, resume, clear, or raise limits. Status updates require an active goal and a nonempty reason; retrying an identical accepted update is idempotent.

Automatic rounds enter the ordinary next-turn inbox with an owner-bound identity. Pending input wins atomic admission. Reservations bind each round to its goal revision; stale rounds stop before inference. Human pause/complete/clear take effect when they enter the inbox, even just after the final checkpoint. Completion, blockers, cancellation, errors, exhausted limits, and budgets stop continuation. Restoring an active goal pauses automatic work until human resume.

Credit spend is checked between steps and turns, so an in-flight response can exceed the goal credit limit. Existing per-request model budget admission remains active. Unknown credit usage with a configured goal budget blocks continuation. An older host without the optional turn_stopping input port reports continuation as unavailable.

The existing status.line slot supplies a typed goal snapshot. Live slots are delivered outside transcript indices, including empty replacement arrays when a goal is cleared.
