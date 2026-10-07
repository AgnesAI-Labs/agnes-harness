# agnes/schedule

Official reminders on the current session. `schedule_create`, `schedule_list`, `schedule_update`, and `schedule_delete` are `defineTool` tools. They store a catalog row and a daemon Job. When the job is due, the daemon starts the session if it is idle and resumes it if a turn is already running.

Five-field cron follows Vixie. A day-of-month or day-of-week field is unrestricted when its text starts with `*`. When both are restricted, a date matches if either field matches. Weekday `7` is Sunday. A zoned expression skips a local time that does not exist and fires a repeated local time once, at the earlier instant. The search horizon is 366 days.

A recurring reminder that was down delivers only its latest missed occurrence, because one job row is claimed once. Deleting a reminder does not retract a message that is already queued. A delivery can be recorded again if the process crashes after the message is queued and the job is reclaimed. `after_seconds` is create-only. A subagent session cannot manage reminders.

The schedules settings page lists the same catalog, including the next run and delivery history.
