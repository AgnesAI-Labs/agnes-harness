# agnes/schedule

Official scheduled tasks. `schedule_create`, `schedule_list`, `schedule_update`, and `schedule_delete` are `defineTool` tools. They call the public scheduling service, which stores a catalog row and a daemon Job; the Web automation page and `_agnes/v1/schedules.list|upsert|archive|control` read and change the same catalog.

## Scheduling service

The official tools use `SchedulingService` from `@agnes/extension-api` exclusively. There is no
worker table handle or package-specific Host injection. A third-party tool can use the same service:

```ts
import { schedulingKind } from '@agnes/extension-api'

// Inside an admitted tool callback; list "providers" in the plugin's inject array.
const scheduling = await ctx.providers.bindOwn(schedulingKind)
const { schedules } = await scheduling.list()
```

Copy the six `schedulingServiceCapabilities` into `agnes.plugins[].capabilities.services` in the
package manifest, and obtain the corresponding service lease grants. The descriptors must match
exactly, including query/effect kind. Binding requires all six grants, and every operation rechecks
the declaration, lease and callback lifetime. Bind within each callback; retaining a facade does
not extend its authority. An unavailable daemon bridge fails closed.

| Method | Result and scope |
| --- | --- |
| `list({ includeArchived?, recentDeliverySince? }?)` | Calling session's tasks; optional latest successful delivery notification to this session |
| `get(id)` | Owned task or `undefined` |
| `upsert({ id?, title, prompt, selector, target? })` | Create/update; omitted target keeps an existing target or defaults to this session |
| `control({ id, action })` | Run, pause or resume an owned task |
| `archive({ id })` | Archive an owned task; inaccessible IDs return `deleted: false` |
| `runs(id)` | Recent runs of an owned task; inaccessible IDs return an empty list |

The Host supplies session and workspace identity. Tasks bound to this session or originating from
it are accessible; other sessions' tasks are hidden. New-session targets must use this workspace
and pass the daemon's existing target checks. Caller-supplied ownership fields cannot grant access.
Semantic validation errors retain their stable schedule code in the RPC error's `data.code`;
update/control refusals retain `{ updated: false, code }`. Existing `_agnes/v1/schedules.*` RPCs and
the automation page keep their current contracts. The scheduling engine remains daemon-owned and
cannot be registered or selected by plugins.

## Targets

Every task has a `target`:

- `{ kind: "session", sessionKey }`: when due, the prompt is enqueued into that session. It starts a turn if the session is idle, joins the running turn otherwise.
- `{ kind: "new-session", cwd, loop?, bundles?, preset?, model? }`: every run opens a fresh session in a registered workspace over the same private local SDK path as chat and webhook triggers, renames it `<title> · <local date time>`, sets the primary model when one is named, and runs the prompt. Workspace ownership, bundle admission, preset policy and approvals apply unchanged; a run that needs approval waits like any session.

`schedules.upsert` checks a new-session target before saving it: the workspace is registered and present, the loop and bundles are available, the preset is allowed (a bundle may bring its own), and the model exists. The same check runs again before each run; a failure is recorded on the run instead of retried, because a retry could open a second session. Rows saved before targets existed read as their session target.

The tools take `target: "new_session" | "current_session"`. A new-session task from a tool uses the calling session's workspace and the default execution mode. The tool description steers recurring work to `new_session` and one-off reminders to `current_session`, and the result's `runsIn` says where the task runs. A subagent session cannot manage tasks.

## Runs

The daemon admits up to 16 jobs at a time across ticks. A long-running job does not block later due
jobs while capacity remains. Shutdown stops admission, aborts active work and waits for its cleanup;
unfinished shutdown leases remain available for the next daemon to reclaim.

Run history keeps the latest 50 runs per task (20 are returned). Outcomes: `running` (a turn started), `waiting_approval` (that turn's session has an open approval; computed when listing), `ran` (the turn ended), `delivered` (the prompt joined a turn that was already running), `failed` with a `reason` code (`workspace_missing`, `loop_missing`, `bundle_unavailable`, `preset_not_allowed`, `model_missing`, `session_unavailable`, `start_failed`, `turn_error`) and an optional detail. A failed occurrence of a repeating task does not end it; the next occurrence is scheduled.

`schedules.control` runs a task now (its job becomes due at once; a repeating rule continues from that run), pauses it (the queued job is cancelled; a run in progress finishes) or resumes it (a new job counted from now; a one-time task whose moment has passed returns `not_future`).

## Rules

Five-field cron follows Vixie. A day-of-month or day-of-week field is unrestricted when its text starts with `*`. When both are restricted, a date matches if either field matches. Weekday `7` is Sunday. A zoned expression skips a local time that does not exist and fires a repeated local time once, at the earlier instant. The search horizon is 366 days.

A recurring task that was down delivers only its latest missed occurrence, because one job row is claimed once. Archiving a task does not retract a message that is already queued. A run can be recorded again if the process crashes after the message is queued and the job is reclaimed. `after_seconds` is create-only.
