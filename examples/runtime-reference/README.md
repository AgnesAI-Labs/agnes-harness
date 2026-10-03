# Runtime reference providers

The sandbox and execution factories are experimental, parallel services. Host startup does not select them: construction requires a current mount resolver, a compiled filesystem policy, authenticated calls, and a content backend that supplies durable Blob retention proofs. Existing command adapters retain their existing behavior.

Build from the repository root with the pinned Node and pnpm versions:

```sh
pnpm install --frozen-lockfile
pnpm --filter @agnes/host build:native
pnpm --filter @agnes/system-node build:native
node examples/runtime-reference/scripts/build-native.mjs
pnpm exec tsx tools/acceptance/runtime/platform/execution.ts
```

The Host build produces its POSIX governor and the existing macOS process identity helpers. `--output-dir ABSOLUTE_DIRECTORY` retains the packaging interface. The separate reference build produces `examples/runtime-reference/dist/native/execution-owner` on macOS; installed Host packages do not depend on the examples directory. Neither provider source contains a command entry point. Worker entry points are test fixtures.

On Darwin, Seatbelt enforces a closed network and the supplied full-access filesystem policy, including the hard deny floor. Directory descriptors and native `fchdir` bind execution to the admitted directory; the native launcher checks that the descriptors still name the original root and a directory within it. Partial-access policies and remote sandbox modes are explicitly unsupported. Secret environment handles are refused with `exec_secret_env_unsupported`; no alternative secret consumer is impersonated.

Execution enforces all six limits. CPU has `RLIMIT_CPU` rounded up to seconds plus tree sampling; open files has `RLIMIT_NOFILE`, with a supported minimum of 32 descriptors. Zero remains a literal ceiling and is refused before launch. Wall time and aggregate output have hard cutoffs. RSS and process count are sampled. The default sampling interval is 10 ms; the independent reference uses process events and 20 ms sampling. Acceptance emits actual maximum sample gaps and measured peaks. This is sampled enforcement, so CPU, RSS, and process counts can exceed their configured ceilings between samples. Output backpressure cannot block the watchdog: outward pipes are nonblocking and failed writes terminate execution with unknown external effects.

Darwin ownership is **cooperative: process group plus an inherited lifeline**. Both implementations enumerate remaining lifeline writers after root exit, kill them, and require EOF and a zero live count before verifying termination. Missing terminal records and unverified ownership stay unknown across recovery. A fully hostile descendant that creates a new session and deliberately closes every inherited descriptor can escape this user-space ownership check. This known security gap blocks production qualification; the providers must remain unselected until it is closed. It does not qualify as strong ownership.

The Linux Host governor requires an empty delegated cgroup v2 directory supplied by a trusted descriptor. It freezes and kills the group and requires `cgroup.procs` to become empty. It refuses launch without delegation. Qualification also requires a protected supervisor and an execution namespace that denies access to cgroup control files; the Linux filesystem isolation service and reference cgroup backend are not qualified yet, so both service providers explicitly reject Linux execution. CI exercises the native delegated ownership path separately. Windows Job Object enforcement is absent and Windows service execution is explicitly unsupported. Existing Windows DACL, PowerShell, and process cleanup adapters are unchanged.
