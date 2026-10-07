# Community examples

These are independent npm packages scaffolded from the author templates. They
import declared package exports, never workspace source files. Requires Node.js
24.10+ and matching preview tarballs; the AGH author packages are not published
to npm yet.

From an AGH checkout, produce artifacts and verify each package outside the repo:

```sh
node --import tsx tools/release/external-examples.ts --keep
```

The script packs the author APIs, their runtime dependencies, the public Host
test-registration bridge, and the harness produced by pack-npx.ts. It copies
sources to an OS temporary directory, supplies a separate HOME for each example,
installs tarballs with lifecycle scripts disabled, and runs npm run build and
npm test. It also checks the installed harness version. It never starts an AGH
daemon, browser, or real model. --keep prints the artifact directory, including
tarballs and independently built examples. Without it, artifacts are removed.

For a quick author-only check, add --author-only; that explicitly skips packing
and installing the harness. The full command needs the native build prerequisites
in the installation guide. Registry dependencies are installed normally, so an
initial run needs network access.

To work from your own copy outside the repository, install **all** tarballs in
the printed directory, then build and test:

```sh
npm install --ignore-scripts /absolute/artifacts/*.tgz
npm run build
npm test
```

Do not substitute workspace links. The examples' tests are small author contract
tests; follow each README to verify actual installation, activation, and session
behavior. The release script rejects private subpath imports, nonliteral module
imports, imports escaping the example, symlinks, and workspace/file dependencies.

| Example | Demonstrates |
| --- | --- |
| [tool-panel](tool-panel/) | Configured deterministic tool, schemas, result panel, errors and cleanup |
| [mcp-skills](mcp-skills/) | Local stdio MCP tools/resources and a runtime Skill referencing a bundled asset |
