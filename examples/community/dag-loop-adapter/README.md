# @community/dag-loop-adapter

A standalone package combining the [checkpointed DAG loop](../../loops/dag-loop/)
with a tiny `defineModelAdapter` implementation. The package was scaffolded from
the model-adapter template. `dag/index.mjs` and its declarations are an unchanged
copy of the upstream DAG example at commit 9aaa4b64; they import only the public
extension API and Node crypto. The wrapper gives this package its own loop ID.

Follow the [external author setup](../README.md) to install preview tarballs, build,
and run the two short tests in `test/combined.test.mjs`. The tests connect the real
demo adapter, DAG driver and tools through public ports, without starting a daemon
or model process. No workspace source imports or workspace links are needed.

## What it runs

The adapter returns a three-node plan. `community_echo` runs for `left` and `right`
in the same ready wave; `community_join` waits for both outputs and returns
`left + right`. A second adapter request summarizes that result as the assistant
message. Successful tool results are schema-checked. There are no network calls,
credentials or filesystem effects. This text-only demonstration adapter accepts
the DAG planning/summary requests and rejects other requests or unknown models.
Its URL is a schema placeholder and is never contacted.

The loop retains the upstream codec and recovery semantics: completed waves are
checkpointed; resuming an unfinished tool wave refuses rather than replaying
uncertain effects. The package exports separate tool, adapter and loop plugins,
injecting `extension`, `modelAdapters` and `loops` respectively. Registrations and
adapter instances belong to their plugin/instance lifecycles.

## Install, configure and select

1. In an isolated AGH instance, use Settings → Plugins to inspect/install
   `file:/absolute/path/to/dag-loop-adapter`. Review and enable the package.
   Inspect the actual backend state and any missing-service errors.
2. Merge the provider fields in `provider.example.json` into that instance's
   profile: append `community-dag` to `provider.adapters` and append the supplied
   route/model to `provider.routes`. Preserve its `provider.package`, other
   adapters, routes and unrelated settings. A plugin registration does not create
   profile routes. Follow the instance's usual configuration reload/restart flow.
3. Open Settings → Plugins → **Defaults for new sessions**. The catalogs should
   contain Loop **community.dag / 0.1.0** and adapter **community-dag / 0.1.0**, with
   model **dag-demo** on route **community-dag**. Select that pair and save, or
   choose the Loop and model explicitly beside the new-session message composer.
4. Start a fresh session and send “Join the demonstration values”. Expect two
   echo calls, then one join, then `left + right`. Session Trace should show
   `community.dag@0.1.0`. A matching selected model needs no API key.

The demonstration factory deliberately uses the fixed `community-dag/dag-demo`
target. Select the matching pair; it does not claim to consume arbitrary picker
choices. Available tools still follow the session preset's disclosure/allow rules.
If a restrictive preset excludes `community_echo` or `community_join`, expose them
through supported preset configuration before running the plan. See
[plugin management](../../../docs/guide/packages.md) for catalog/default behavior.

## Cleanup and validation scope

Clear defaults referring to this package, then disable/remove it through plugin
management. Remove its route and adapter entry from the isolated profile through
the same configuration flow. New sessions should lose its catalog entries and
tools. Existing sessions may keep generation bindings. The tests verify planning,
parallel batching, joining, final output, tool cleanup, model catalogs, cancellation
and rejected selections. Real UI selection, profile activation and session metadata
are manual checks; author tests alone do not prove those runtime paths.
