# Working on Agnes Harness

Read [README.md](README.md), the [documentation](docs/README.md), and the relevant module before making changes. Development pull requests are currently limited to invited internal collaborators; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Repository map

- `packages/`: protocol, Core, Host, daemon, clients, extensions and supporting libraries.
- `examples/`: runnable plugin examples and explicit test fixtures.
- `docs/`: user guides, extension tutorials, architecture and maintenance policies.
- `tools/`: generation, acceptance checks, documentation verification and repository guards.
- `third-party/`: dependency provenance; root `NOTICE` and package-local licenses cover attribution.

Use the [source map](docs/develop/source-map.md) to locate the owning module. Preserve package boundaries and consume declared exports. Protocol schemas and generators own generated types and reference documents.

## Workflow

1. Inspect Git status, the configured remotes and recent changes. Preserve other contributors' work; integrate remote changes without rewriting shared history.
2. For changes to public APIs, architecture, storage or security boundaries, describe the design and compatibility impact before implementation.
3. Keep changes focused. Update the affected guides, contracts and meaningful tests in the same change.
4. Run checks appropriate to the affected behavior. Report the commands, results, failures and untested environments accurately.
5. Review the final diff before committing. Commit, push and publish only within the user's or maintainer's authorization.

## Build and checks

Use the Node.js requirement and pinned pnpm version in `package.json`. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @agnes/host build:native
pnpm --filter @agnes/system-node build:native
pnpm typecheck
pnpm lint
pnpm gen:check
node tools/public-docs/verify.mjs
pnpm exec vitest run tools/guards/src --maxWorkers=1
```

Run affected package tests from the repository root. `pnpm test` runs the fast tier, `pnpm test:heavy` runs the real-process and large-data tests (`*.e2e.test.ts`, `*.slow.test.ts`), and `pnpm test:all` runs both. Run a single file of either tier with `pnpm exec vitest run <file>`. A focused test command must actually execute matching tests. For a complete local runtime, follow the [installation guide](docs/guide/install.md).

## Engineering boundaries

- Keep session facts and authorization decisions in their owning backend modules; clients render and request operations through supported interfaces.
- Maintain fail-closed behavior, lifecycle cleanup, cancellation and recovery semantics. Test refusal and failure paths when changing them.
- External UI libraries belong in `packages/web-ui`; other packages use its exports. Preserve the shared theme tokens, accessibility, CSP and public skin hooks.
- Keep guards meaningful. Update exact line budgets or fixture allowances only for reviewed changes; do not remove checks to hide a regression.
- Preserve third-party licenses, copyright notices and source attribution. Update dependency provenance when changing dependencies.
- Keep credentials, customer data, private traces, machine-specific configuration and internal project records out of the repository. Use isolated homes and synthetic accounts for tests.

Release requirements are in [release checks](docs/maintainers/release.md); document maintenance is described in [the maintenance guide](docs/maintainers/maintenance.md).
