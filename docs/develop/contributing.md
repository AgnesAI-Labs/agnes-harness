# Development and feedback

English | [简体中文](contributing.zh-CN.md)

<a id="开发协作与问题反馈"></a>

[Documentation](../README.md) · [Source map](source-map.md)

AGH benefits from experience in real deployments. Try it, study the source, and build plugins for your own projects under the applicable licenses.

<a id="关注项目分享你的场景"></a>

## Follow the project and share your scenario

- **Star:** Save the project and help other developers discover AGH.
- **Watch:** Follow the updates that matter to you.
- **Try and share:** Run an example and share your experience with developers building agent applications and business integrations.
- **Report issues and requests:** Describe your goal, the problem, or a scenario you want to integrate through Issues. See the [report template](#write-a-useful-issue-report) below.

Report vulnerabilities privately through the [security policy](../../SECURITY.md).

<a id="当前代码协作方式"></a>

## Current development policy

**Code and documentation PRs are currently limited to invited internal developers. External PRs are not accepted at this stage.** You may use, study, and extend AGH in your own projects under the applicable licenses. The development workflow below is for invited collaborators.

<a id="受邀开发者的工作入口"></a>

## Starting points for invited developers

| Work area | Prepare | Acceptance criteria |
| --- | --- | --- |
| Improve onboarding | The blocking step, environment, and actual error | Another reader can follow the revised instructions |
| Add a plugin example | A small use case, complete source, and configuration | Install, verify, and clean it up without private credentials or business data |
| Fix a runtime issue | Minimal reproduction, expected and actual behavior | Change the owning module and verify relevant behavior and refusal paths |
| Validate an environment | OS/architecture, Node, source revision, commands | Preserve actual results and failures; do not generalize one platform to all |
| Explore domain/device integration | Requirements, interfaces, and acceptance criteria | Begin with a reviewable proposal or read-only simulation; keep plans distinct from delivery |

<a id="一个小而完整的内部改动"></a>

## A small, complete internal change

1. Prepare the [source build](../guide/install.md) and use the [demo](../guide/demo.md) to understand existing behavior.
2. Locate the owning module through the [source map](source-map.md), then inspect neighboring examples and tests.
3. State the problem and scope before changing code or documentation. Discuss new public contracts, security boundaries, or cross-module behavior first.
4. Run relevant checks, record failures and untested environments, and update affected guides.
5. Prepare a reviewable diff describing the problem, new behavior, reproduction steps, and verification. Keep unrelated changes separate.

Project-authored code uses [Apache-2.0](../../LICENSE); see [licensing](../maintainers/provenance.md) for third-party and example exceptions. Contributions intentionally submitted for inclusion are covered by Apache-2.0 contribution terms unless explicitly stated otherwise. Use the repository's collaboration and review process, and keep private repository URLs, accounts, and internal task records out of public reports. Accepting external PRs would be a separate policy decision.

<a id="提供一个有用的问题报告"></a>

## Write a useful issue report

The repository includes [bug report](../../.github/ISSUE_TEMPLATE/bug_report.yml) and [use-case suggestion](../../.github/ISSUE_TEMPLATE/feature_request.yml) forms under Issues → New issue. Chinese and English are welcome. Feedback does not require a code PR.

You can also use this structure, removing irrelevant fields:

```text
Goal: what I wanted to accomplish
Version: source commit, Node/pnpm, OS/architecture
Steps: minimal reproduction commands and required configuration (redacted)
Expected: the result that should occur
Actual: error code, operation status, or relevant log excerpt
Checks: whether it reproduces in an isolated home and what I have already checked
```

Include only the minimum information needed. Conversations, complete databases, environment variables, and screenshots may contain business data. Send security reports privately through the repository's [security policy](../../SECURITY.md).

<a id="日常命令"></a>

## Everyday commands

```sh
pnpm install --frozen-lockfile
pnpm --filter @agnes/host build:native
pnpm --filter @agnes/system-node build:native
pnpm typecheck
pnpm lint
pnpm gen:check
pnpm test
```

Both `build:native` commands are package-level scripts matching [CI](../../.github/workflows/ci.yml) prerequisites. On macOS, process-identity tests need the Host helper and atomic Skill publication tests need the system-node helper. Missing helpers cause environment failures, which should be distinguished from product defects. Root `pnpm test` runs the fast tier with one worker by default, including guards. Real daemon, worker and CLI process tests are named `*.e2e.test.ts`, and large-ledger or timer-bound tests `*.slow.test.ts`; `pnpm test:heavy` runs only those, and `pnpm test:all` runs everything. `pnpm exec vitest run <file>` runs one file of either tier. The tier comes only from the file suffix: name a new test `*.e2e.test.ts` or `*.slow.test.ts` to put it in the heavy tier. A package's own `test` script runs both tiers of that package, while the root `pnpm test` runs the fast tier only. For a local module change, start with relevant tests and expand according to risk. Documentation-only changes usually do not require model or full end-to-end reruns.

```sh
pnpm exec vitest run packages/cli/test/args.test.ts --maxWorkers=1
pnpm --filter @agnes/cli build:local
pnpm --filter @agnes/web build
node tools/public-docs/verify.mjs
pnpm exec vitest run tools/public-docs/examples.test.ts --maxWorkers=1
```

Rebuild the full distribution after source or resource changes. A Web-only build is not a complete daemon/worker distribution. Do not rebuild a directory currently used by someone's running instance.

<a id="合同与测试层级"></a>

## Contracts and verification levels

Handwritten schemas live in `packages/protocol/schema`, with generated TypeScript in `gen/ts`. Do not edit generated output to bypass checks. For API changes, review providers, SDK, CLI/Web consumers, and negative cases together. `gen:check` establishes consistency, not runtime behavior.

| Evidence | Establishes | Does not establish |
| --- | --- | --- |
| Lint / types / links | Syntax, types, references, and selected rules | Actual startup or model quality |
| Unit/component tests | Local behavior and failure handling for specified inputs | All platforms or network environments |
| Local process integration | Real distribution, daemon/worker/SQLite/loopback communication | Real model tool selection or remote deployment |
| Browser acceptance | Interaction and call chains in a specified browser | All browsers, assistive technologies, or platforms |
| External model/device/deployment acceptance | Results for a specified account, environment, and revision | Automatic applicability to other environments |

Execution changes should cover permission denial, cancellation, duplicate requests, unknown receipts, recovery, and cleanup. Plugin update changes should verify old-row retention/removal, failed-candidate cleanup, stale browser revisions, and dependencies. A happy-path assertion that merely mirrors the implementation is insufficient evidence for these boundaries.

<a id="代码与审查"></a>

## Code and review

Use the repository's TypeScript strict, ESM, and Biome settings. Consume public exports, preserve dependency direction, and avoid deep-importing Host from UI. Side effects, timers, and listeners need explicit disposal/cancellation. Errors and logs must not expose raw secrets or inputs. Preserve provenance and licenses when reusing third-party code, and maintain the lockfile.

A reviewable change states the problem, before/after behavior, scope, actual verification, failures, and external coverage gaps. New public contracts or security-boundary changes need prior design discussion. Deliver documentation with the code instead of reconstructing interfaces afterward.

Test in an isolated temporary AGH_HOME. Real-model and system-permission checks require a specified environment and authorization. Never automatically copy real keys from personal defaults into tests. Reports should include error codes, versions, reproduction steps, and redacted minimal input rather than a complete home, database, or private trace.

<a id="文档维护"></a>

## Documentation maintenance

Use the [module mapping](../maintainers/maintenance.md) to find affected pages. Update reference, tutorial, and verification together when adding a command. Every page under `docs/` has complete English and Simplified Chinese editions; update both in the same change, including examples and limits. Run the documentation checks for translation pairs, language navigation, local links, and source anchors.
