# DevBoard R&D lifecycle workbench

English | [简体中文](README.zh-CN.md)

A full-lifecycle R&D workbench demo for a rail-equipment company: requirements → architecture → development → test acceptance. **The company "Ningchuan Transportation Equipment Co., Ltd." (宁川交通装备股份有限公司), its customers, metro lines and people are fictional, and all data is simulated**; no external system (PLM, ERP, QIS, MES …) is contacted. Anything about safety integrity is stated as an assumption under EN 50126 / EN 50716 (formerly EN 50128).

After installing and adopting DevBoard 2.1.0 on the Agents page, the workbench shows seven pages and an **R&D Coordinator** agent. Three projects are seeded at different stages:

| Project | Kind | Stage | Shows |
| --- | --- | --- | --- |
| PRJ-2025-042 Ningchuan Metro Line 9 vehicle door system | New build | Verification (overdue) | CUS/SYS/SWR/DES/TC traceability with an uncovered SWR-025 and a sourceless TC-038; an approved change that sent design to rework; a change awaiting the CCB |
| PRJ-2026-008 Ningchuan Metro Line 2 platform screen door retrofit | Retrofit | Design in review | A design gate with two open findings: no approval until they are closed |
| PRJ-2025-019 Door system O&M platform V2.0 | Software | Released | Every stage passed, with full history and baselines |

| Page | What it shows |
| --- | --- |
| Portfolio | Project cards: stage bar, gates, three coverage figures, defects, test pass rate, changes and risks; global to-dos; new project; reset demo data |
| Projects | Stage timeline: deliverables, gates, baselines, authoring roles, planned and actual dates; Markdown preview of deliverables; risks; "open app" for live projects |
| Traceability | Matrix by level (CUS/SYS/SWR/DES/TC), three coverage figures, highlighted orphans; board requirement items |
| Tasks | Task board, filterable by project |
| Changes | Change requests: impact analysis, CCB decision, transitions and rework |
| Defects & tests | Defect transitions, eight-week opened/closed trend, test runs |
| Reviews | Pending and decided gates (approve, reject, close findings, continue); human-intervention requests |

The board polls every 10 seconds. The demo-role switch only signs decisions; it is not a login or a security boundary. First article inspection, site acceptance, independent safety assessment and FMEA/FTA happen outside this workbench and are not modelled.

## Rules

Every write goes through one set of functions in `domain.mjs`, shared by pages and agent tools.

- **Stages**: NOT_STARTED → IN_PROGRESS → IN_REVIEW → PASSED; IN_REVIEW → REWORK → IN_PROGRESS. A stage starts only after the previous one passed.
- **Review gates** (refusals read `评审门不满足：…`): only a stage in review can be decided; the approving role must not be the stage's authoring role; every finding must be closed before approval. Approval passes the stage, baselines its deliverables and records a baseline; rejection needs a comment and sends the stage to rework. Implementation has no human gate and passes once all code-review findings are closed.
- **Traceability**: CUS→SYS, SYS→SWR and SWR→TC coverage; submitting the requirements stage with CUS→SWR below 100% adds a finding automatically.
- **Changes**: SUBMITTED → ANALYZED (needs an impact analysis) → CCB_REVIEW → APPROVED / REJECTED → IMPLEMENTED → CLOSED. Approval marks impacted requirements CHANGED and sends impacted passed stages to rework.
- **Defects**: NEW → CONFIRMED → FIXING → RETEST → CLOSED, or DEFERRED.
- The v1 requirement, task and human-intervention machines and their linkage are unchanged.

## Agent and live project

`coordinator` carries all 15 `devboard_*` tools, file and shell tools, `tool_search` / `tool_describe`, `subagent_spawn` / `subagent_collect` and the `devboard-playbook` skill (lifecycle, role prompts, file layout, gate rules). Its `devboard` preset pre-approves edits and writes inside the workspace; every shell command (including `node --test` and `node server.js`) asks for approval, because it runs code the agents wrote. Five declared delegable agents (`requirements`, `architect`, `developer`, `reviewer`, `tester`) run as fresh role children with the parent’s shared working directory and a role ∩ parent capability snapshot. The reviewer is read-only; the other specialists can edit project files. Specialists have no shell or board tools and cannot approve or sign. They return commands to the coordinator for human approval and execution. All roles narrate in Chinese unless the user chooses another language, and use business labels instead of raw status enums.

The preset explicitly requests reviewed `sandbox.loopback_serve` under required L1 enforcement with `on_unavailable: deny` and no external network allowlist. Command approval remains mandatory. The supported macOS sandbox permits local TCP serving; unsupported sandbox backends refuse this capability rather than falling back. Use a platform build supporting this capability before the live demo.

The live project "Door health monitoring dashboard" is a dependency-free Node web app written under `devboard-projects/<project id>/` in the workspace. Role child agents only work on workspace files; only the coordinator writes to the board. After submitting each gate the coordinator ends its turn; a person decides on the board, then presses "Continue", which opens a coordinator draft carrying the gate id for the person to send.

### Demo script and checkpoints

1. Portfolio: three projects, one pending gate, PRJ-2025-042 overdue.
2. Reviews → GATE-PRJ-2026-008-DESIGN-1: approving as 技术负责人 is refused for two open findings; approving as 软件架构师 is refused because that is the authoring role; approving a decided gate is refused as not in review. Close both findings with notes and approve as 技术负责人: the stage passes with baseline BL-008-SAD-V1.0.
3. Traceability: PRJ-2025-042 SWR→TC is 96%, with SWR-025 and TC-038 highlighted.
4. Changes: approving CR-2026-031 at the CCB sends PRJ-2025-042's requirements and design stages to rework.
5. Live project: workbench action "Create and start an R&D project". After each submitted gate the board shows the stage in review with its new deliverable and the workspace holds the file; decide, then press "Continue".
   - Gate 1 initiation (研发总监): `docs/PROJECT-PLAN.md`.
   - Gate 2 requirements (项目经理): a typed `requirements` task card and child-authored `docs/SRS.md`, `docs/RTM.md`; CUS/SYS/SWR appear in traceability.
   - Gate 3 design (技术负责人): a typed `architect` child; `docs/SAD.md`; DES linked to SWR.
   - Implementation: typed `developer` and separate read-only `reviewer` children; `src/`, `server.js`, `test/`; pass only after findings are resolved and independently rechecked.
   - Gate 4 verification (质量负责人): typed `tester` writes independent tests from the SRS and public HTTP contract. The coordinator runs them against a real TCP listener; record command, cwd, counts and remaining gaps under Defects & tests and in `docs/TEST-REPORT.md`. Internal handler calls do not satisfy acceptance.
   - Gate 5 acceptance (质量负责人): `docs/RELEASE-NOTE.md`; HTTP readiness and real browser checks of the line → vehicle → door view and fault ranking pass, then register the app. "Open app" appears on the project page. Keep the background job id and stop it after the demo.

A real model may need tens of minutes for the whole flow.

Run commands from the correct directory: shell defaults to the workspace root. Pass actual test files, for example `node --test devboard-projects/<project id>/test/unit.test.js devboard-projects/<project id>/test/acceptance.test.js`, or set shell `cwd` to `devboard-projects/<project id>/` and run `node --test` for discovery. Do not pass the `test/` directory as a positional argument. Set project `cwd` for `node server.js --port <free port>` too; bind only `127.0.0.1`, never use ports 4177/4178. No external network or package installation is needed.

If role delegation fails, mark role independence as unmet and keep the quality finding open; coordinator self-review cannot replace an independent role. Listener or browser failures remain acceptance blockers. Do not close a finding merely by moving it to a later stage, or register an unverified URL.

### Presenter checklist

- Use an isolated home and workspace, a configured real model, a free app port and one or two browser tabs. Review the installed package version and permissions before adopting it.
- Rehearse all five gates with typed role task cards and verify parent/child file visibility. Check Chinese progress narration and business state labels.
- Review each command and cwd before approval. Avoid unnecessary shell probes such as `node --version`; commands execute generated code. Tainted results can also require approval for later writes or board operations; read the action title and evidence.
- Before gates 4–5, require real HTTP test logs and browser evidence, resolve findings, verify the registered URL, and retain timing per gate. Confirm how to stop the background job.

## Layout

- `domain.mjs`: stages, gates, traceability, changes, defects, tests and the v1 machines; metrics; storage (chunked under the 64 KiB value cap).
- `seed-data.mjs`, `seed-docs/`: the fictional portfolio and its document bodies.
- `index.mjs`: profile services `devboard.snapshot`, `devboard.artifact`, `devboard.transition`, `devboard.create`, `devboard.gate`, `devboard.reset`, agent tools and the skill.
- `skills/devboard-playbook.md`: the coordinator skill.
- `client/`: seven pages built with `@agnes/web-ui`.
- `test/`: domain rule and seed data tests.

```sh
pnpm exec vitest run examples/showcase/devboard/test --maxWorkers=1
```

Upgrading from 1.0.0: stored v1 data (schema 1) reads as the seed and is replaced on the first write. To try it from source, follow [installation](../../../docs/guide/install.md), open the Agents page, install DevBoard, then adopt it.
