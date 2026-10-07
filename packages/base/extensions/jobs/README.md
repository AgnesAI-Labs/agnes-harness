# Session jobs

Official `shell` uses a confined POSIX process group and this process-owned session/lane registry. `job_list`, `job_output` and `job_kill` operate only on that owner. Foreground timeout hands back the same running process; session shutdown drains and kills it. See [default tools](../../../../docs/reference/default-tools.md) for inputs, limits and backend support.

The registry is shared by the tools-core and jobs factories through the Host generation signal. Entries live across turns, not process restart. Both extension shutdown paths clean jobs; there is no dependency on the artifact seam's asynchronous job protocol.
