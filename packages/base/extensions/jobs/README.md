# Session jobs

One session/lane registry owns shell commands, persistent Bash/Zsh/PowerShell sessions, PTYs and child-agent views. Use `job_list`, `job_output` and `job_kill` for every kind. Completion notices appear in subsequent model context and in the Web jobs panel. Child-agent status/output is refreshed from the public parent-bound child port.

`shell` is stateless by default. Set `persistent:true` and optionally `shell:"bash"|"zsh"|"pwsh"`; the result includes `sessionId` and command `jobId`. Subsequent calls reuse that shell or explicitly select its `sessionId`. Cwd, environment and interpreter variables persist. One command runs at a time; another command refuses while busy. A foreground timeout returns the same command job. Killing that job closes its persistent interpreter. Commands that read interactive stdin belong in a PTY.

`pty_open/read/send/signal/resize/list/close` provide interactive processes under the selected sandbox preset. The optional public Host process port owns spawning and tree cleanup; missing support refuses before launch. Local PTY uses a native relay on macOS/Linux. Local Windows supports pipe execution; PTY requires a supporting provider. Bash, Zsh and PowerShell must be installed where execution occurs. Remote providers must implement the process entry; there is no local fallback.

Capture is bounded to 4 MiB per job; the registry retains 128 jobs per session/lane, evicting completed entries first. Job and command metadata is abbreviated. Jobs survive calls and turns, not Host restart. Session shutdown, extension revocation and provider disposal drain the processes. Refreshing the browser detaches/reconnects; explicit terminal Close kills.

The separate `agnes/jobs-web` extension declares `jobs.read` (query) and `jobs.control` (journaled effect). New default profile templates admit `services`. Existing profiles must add that capability to enable Web control; profiles that omit it keep their original shell/job tools. The built-in Web panel uses the existing authenticated client-service BFF and the session's registered extension, grants and sandbox posture.

See [default tools](../../../../docs/reference/default-tools.md) and [Web guide](../../../../docs/guide/web.md).
