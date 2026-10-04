# Runtime API

`@agnes/runtime-api` defines runtime ownership, catalog metadata, the minimal session lifecycle,
and an exact-version factory registry. It depends on neither Core nor a particular loop.
Static Host assembly registers implementations today; a future trusted plugin loader can use
the same registration lifecycle without changing the runtime implementation.

## Host integration

1. Decode the persisted `session/start.data.runtime` with `readRuntimeIdentity` before repair.
   Only a missing value denotes historical `native@1`; malformed values and incompatible owners
   fail closed. A new session's selected owner must be written in its first durable transaction.
2. Construct `RuntimeRegistry<HostOpenContext, HostSessionPort>`. The opening context supplies
   scoped execution, model, storage, workspace and event capabilities. It must not expose the
   complete Host or Kernel. `HostSessionPort` composes the command and read interfaces used by
   workers with `RuntimeSession`; existing Core sessions already satisfy the minimal lifecycle.
3. Acquire the selected identity before opening. Its lease pins the exact factory generation.
   Transfer the lease into the Host-owned session lifecycle, release after successful close,
   and release on failed open after the factory has rolled back its resources. Opening failure
   does not release automatically; the Host retains ownership until it handles that outcome.
4. Retire registrations before Host shutdown or implementation replacement, close their sessions,
   then await `whenDrained()`. A failed close must retain its lease and remain visible to the owner;
   retirement never silently cancels work. A pending opening cannot release its lease.

Each lease opens at most one session. The Host must serialize/cache session creation by session
key and preserve writer ownership; registry admission does not replace those checks. A lease
admitted before retirement may finish opening. A new registration may reuse the retired identity,
but existing leases retain the prior factory and generation. Generation is not a durable runtime
version and is not published as session ownership.

## Boundaries

Descriptors report supported operations; consumers must refuse unsupported commands without
falling back to another loop. The registry refuses unavailable implementations and unknown exact
versions. It does not discover or load plugins, authorize registrations, run migrations, recover
sessions, or grant tool permissions. The owning runtime makes the sole recovery decision using
Host-provided execution evidence. Runtime-specific state and event validation remain with that
implementation; Native Core's program counter is not part of this API.

The registry's lease is a lifecycle ownership contract for trusted Host code, not a sandbox. Calling
`release()` does not close a session or prove it has drained; only its Host lifecycle may release it.

## Checks

From the repository root: `pnpm exec vitest run packages/runtime-api/test/registry.test.ts`.
The tests cover owner compatibility, independent factories, retirement during pending creation,
generation replacement, unavailable registrations, and immutable catalog snapshots.
