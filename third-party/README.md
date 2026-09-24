# Dependency provenance

This directory records the provenance of every external dependency declared directly by a
workspace importer in `pnpm-lock.yaml`.

- [`runtime-dependencies.json`](./runtime-dependencies.json) covers product runtime and optional
  integrations.
- [`build-dependencies.json`](./build-dependencies.json) covers build, test, type and development
  tooling.

Each record contains the exact locked version, upstream source repository, declared license,
current purpose, adoption rationale and every workspace importer that directly declares it.
Workspace-local `workspace:` links are intentionally excluded because they are maintained in this
repository rather than obtained from a third party. Transitive versions and registry integrity
remain authoritative in `pnpm-lock.yaml`.

`tools/guards/src/provenance.test.ts` compares these records with the lockfile. Adding, removing or
upgrading a direct dependency requires updating the relevant provenance record in the same change.

This inventory is evidence of dependency origin, not a vulnerability audit, legal advice, a
project-license decision or approval to redistribute a package.
