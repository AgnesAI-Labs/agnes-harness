# DevBoard R&D lifecycle workbench

English | [简体中文](README.zh-CN.md)

A full-lifecycle R&D workbench demo for a rail-equipment company: requirements → architecture → development → test acceptance. **The company "Ningchuan Transportation Equipment Co., Ltd." (宁川交通装备股份有限公司), its customers, metro lines and people are fictional, and all data is simulated**; no external system (PLM, ERP, QIS, MES …) is contacted. Anything about safety integrity is stated as an assumption under EN 50126 / EN 50716 (formerly EN 50128).

After installing and adopting DevBoard 2.0.0 on the Agents page, the workbench shows seven pages and an **R&D Coordinator** agent. Three projects are seeded at different stages:

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

`coordinator` carries all 15 `devboard_*` tools, file and shell tools, `tool_search`, `subagent_spawn` / `subagent_collect` and the `devboard-playbook` skill (lifecycle, role prompts, file layout, gate rules). Its `devboard` preset pre-approves edits and writes inside the workspace; every shell command (including `node --test` and `node server.js`) asks for approval, because it runs code the agents wrote. Child agents share the parent's working directory.

The live project "Door health monitoring dashboard" is a dependency-free Node web app written under `devboard-projects/<project id>/` in the workspace. Role child agents only write files; only the coordinator writes to the board. After submitting each gate the coordinator ends its turn; a person decides on the board, then presses "Continue", which opens a coordinator draft carrying the gate id for the person to send.

### Demo script and checkpoints

1. Portfolio: three projects, one pending gate, PRJ-2025-042 overdue.
2. Reviews → GATE-PRJ-2026-008-DESIGN-1: approving as 技术负责人 is refused for two open findings; approving as 软件架构师 is refused because that is the authoring role; approving a decided gate is refused as not in review. Close both findings with notes and approve as 技术负责人: the stage passes with baseline BL-008-SAD-V1.0.
3. Traceability: PRJ-2025-042 SWR→TC is 96%, with SWR-025 and TC-038 highlighted.
4. Changes: approving CR-2026-031 at the CCB sends PRJ-2025-042's requirements and design stages to rework.
5. Live project: workbench action "Create and start an R&D project". After each submitted gate the board shows the stage in review with its new deliverable and the workspace holds the file; decide, then press "Continue".
   - Gate 1 initiation (研发总监): `docs/PROJECT-PLAN.md`.
   - Gate 2 requirements (项目经理): `docs/SRS.md`, `docs/RTM.md`; CUS/SYS/SWR appear in traceability.
   - Gate 3 design (技术负责人): `docs/SAD.md`; DES linked to SWR.
   - Implementation: `src/`, `server.js`, `test/`; passes when code-review findings are closed.
   - Gate 4 verification (质量负责人): `node --test` green, a live run under Defects & tests, `docs/TEST-REPORT.md`.
   - Gate 5 acceptance (质量负责人): `docs/RELEASE-NOTE.md`; "open app" appears on the project page and opens in a browser.

A real model may need tens of minutes for the whole flow.

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
