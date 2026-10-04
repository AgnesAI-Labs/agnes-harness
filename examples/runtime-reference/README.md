# Runtime reference providers

The experimental embedding factories expose a recoverable `encode` leaf and an injected public Usage control port. They currently accept explicit synthetic, credential-free loopback fixtures through the restricted network effect port. The contract fixtures consume the public default Usage provider with durable synthetic source observations. Live embedding model calls, pricing, settlement and startup selection require their owning services before production activation.

Embedding results use the official `agh.embedding/vectors@1` schema. Both implementations check the content digest, the input digest, row count, dimensions, finite values and requested unit normalization before returning vectors. Encode requests are bounded inline references; vector content can be inline or a pinned JSON Blob up to 1 MiB. Consumers must validate vectors before updating their index. Failed vector validation preserves recorded usage; a sent request with no confirmed result remains unknown across process recovery and is never sent again.

The sandbox and execution factories are experimental, parallel services. Host startup does not select them: construction requires a current mount resolver, a compiled filesystem policy, authenticated calls, and a content backend that supplies durable Blob retention proofs. Existing command adapters retain their existing behavior.

Build from the repository root with the pinned Node and pnpm versions:

```sh
pnpm install --frozen-lockfile
pnpm --filter @agnes/host build:native
node examples/runtime-reference/scripts/build-native.mjs
pnpm --filter @agnes/system-node build:native
pnpm exec tsx tools/acceptance/runtime/platform/execution.ts
```

The Host build produces its POSIX governor and the existing macOS process identity helpers. `--output-dir ABSOLUTE_DIRECTORY` retains the packaging interface. The separate reference build produces `examples/runtime-reference/dist/native/execution-owner` on macOS; installed Host packages do not depend on the examples directory. Neither provider source contains a command entry point. Worker entry points are test fixtures.

Sandbox creation and execution now refuse before effects whenever a mandatory resource limit has no real hard gate. All six ResourceLimits fields are required, and zero is literal zero: it is refused as a quota before launch. Darwin and the independent reference cannot impose tree memory/process ceilings, so they return incompatible refusals and advertise no launch features. No filesystem probes or launch callback run after this refusal. Secret environment handles still return `exec_secret_env_unsupported`.

Resource sampling and observed peaks are diagnostic only. Neither a sampling interval nor a maximum observed gap establishes a hard limit or an upper bound on excursions between samples. Per-process, rounded CPU limits and descriptor limits do not establish exact aggregate tree limits.

The conformance report tests admission denial, cancellation before admission and disposal. Selection, normal execution and cold recovery are explicitly unqualified and incomplete; a refusal is never counted as normal execution or recovery evidence.

The retained Darwin native ownership machinery is **cooperative: process group plus an inherited lifeline**. Its ownership routines enumerate remaining lifeline writers after root exit, kill them, and require EOF and a zero live count before verifying termination. Mandatory requests are currently refused before entering this ownership path. Missing terminal records and unverified ownership stay unknown across recovery. A fully hostile descendant that creates a new session and deliberately closes every inherited descriptor can escape this user-space ownership check. This known security gap blocks production qualification; the providers must remain unselected until it is closed. It does not qualify as strong ownership.

The Linux Host governor requires a trusted descriptor for an empty real cgroup v2 domain, including empty descendants. It sets and reads back `memory.max`, `memory.swap.max=0`, `pids.max` and `memory.oom.group=1` before any business fork. Missing/bad delegation, failed writes and mismatched readback refuse with zero business launches. These verified controller gates still do not implement exact tree CPU-total or aggregate open-file limits; the native governor therefore refuses the complete mandatory request. Membership cleanup proves ownership and termination only.

Linux controller tests require `AGNES_TEST_CGROUP` pointing to a genuine delegated empty parent with memory/pids controllers enabled. CI runs the controller gate, injected syscall failure and nested-tree tests separately; machines without this delegation skip the positive proofs explicitly. The reference cgroup backend and Linux filesystem isolation remain unavailable. Windows service execution still refuses mandatory openFiles; legacy command adapters retain their existing behavior.
