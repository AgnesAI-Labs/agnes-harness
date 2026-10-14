# agnes/schedule

Official scheduled tasks. `schedule_create`, `schedule_list`, `schedule_update`, and `schedule_delete` are `defineTool` tools. They store a catalog row and a daemon Job; the Web automation page and `_agnes/v1/schedules.list|upsert|archive|control` read and change the same catalog.

## Targets

Every task has a `target`:

- `{ kind: "session", sessionKey }`: when due, the prompt is enqueued into that session. It starts a turn if the session is idle, joins the running turn otherwise.
- `{ kind: "new-session", cwd, loop?, bundles?, preset?, model? }`: every run opens a fresh session in a registered workspace over the same private local SDK path as chat and webhook triggers, renames it `<title> · <local date time>`, sets the primary model when one is named, and runs the prompt. Workspace ownership, bundle admission, preset policy and approvals apply unchanged; a run that needs approval waits like any session.

`schedules.upsert` checks a new-session target before saving it: the workspace is registered and present, the loop and bundles are available, the preset is allowed (a bundle may bring its own), and the model exists. The same check runs again before each run; a failure is recorded on the run instead of retried, because a retry could open a second session. Rows saved before targets existed read as their session target.

The tools take `target: "new_session" | "current_session"`. A new-session task from a tool uses the calling session's workspace and the default execution mode. The tool description steers recurring work to `new_session` and one-off reminders to `current_session`, and the result's `runsIn` says where the task runs. A subagent session cannot manage tasks.

## Runs

Run history keeps the latest 50 runs per task (20 are returned). Outcomes: `running` (a turn started), `waiting_approval` (that turn's session has an open approval; computed when listing), `ran` (the turn ended), `delivered` (the prompt joined a turn that was already running), `failed` with a `reason` code (`workspace_missing`, `loop_missing`, `bundle_unavailable`, `preset_not_allowed`, `model_missing`, `session_unavailable`, `start_failed`, `turn_error`) and an optional detail. A failed occurrence of a repeating task does not end it; the next occurrence is scheduled.

`schedules.control` runs a task now (its job becomes due at once; a repeating rule continues from that run), pauses it (the queued job is cancelled; a run in progress finishes) or resumes it (a new job counted from now; a one-time task whose moment has passed returns `not_future`).

## Rules

Five-field cron follows Vixie. A day-of-month or day-of-week field is unrestricted when its text starts with `*`. When both are restricted, a date matches if either field matches. Weekday `7` is Sunday. A zoned expression skips a local time that does not exist and fires a repeated local time once, at the earlier instant. The search horizon is 366 days.

A recurring task that was down delivers only its latest missed occurrence, because one job row is claimed once. Archiving a task does not retract a message that is already queued. A run can be recorded again if the process crashes after the message is queued and the job is reclaimed. `after_seconds` is create-only.
