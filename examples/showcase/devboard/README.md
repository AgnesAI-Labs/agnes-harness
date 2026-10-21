# DevBoard R&D agent board

English | [简体中文](README.zh-CN.md)

A proof-of-concept application: a task board for multi-agent software delivery. It is a demo, not a production system. **All data is fictional and synthetic**; no external system is contacted.

After installing and adopting DevBoard on the Agents page, the workbench shows four pages and an **R&D Coordinator** agent:

| Page | What it shows |
| --- | --- |
| Overview | Counts per state for requirements, tasks and human-intervention requests, plus recent activity and a reset button for the demo data. |
| Requirements | Filter by state; a detail page shows related tasks and history and offers transitions (refine, send back, assign …). |
| Tasks | Filter by state and type; list or board view (one column per state); start, complete, fail, retry, block, unblock, cancel. |
| Human interventions | Overdue requests are marked red and listed first, the rest newest first; claim, release, resolve; filter by type. |

The board polls every 10 seconds, so changes made by the agent appear without a manual refresh. A demo-role switch (manager, coordinator, engineer, quality & security) only signs actions and hides the claim button for engineers; it is not a security boundary.

## State machines

Every write goes through one transition function; any move not listed is refused with `非法状态流转：A 不可流转至 B` ("illegal transition: A cannot move to B").

- Requirement: RAW → REFINED; REFINED → RAW / ASSIGNED; ASSIGNED → REFINED / IN_PROGRESS; IN_PROGRESS → BLOCKED / COMPLETED; BLOCKED → IN_PROGRESS.
- Task: PENDING → IN_PROGRESS / BLOCKED / CANCELLED; IN_PROGRESS → COMPLETED / FAILED / BLOCKED; BLOCKED → IN_PROGRESS / CANCELLED; FAILED → PENDING / CANCELLED.
- Human intervention: OPEN → CLAIMED; CLAIMED → OPEN / RESOLVED. An OPEN request past its deadline reads as EXPIRED (derived on read, no timer) and can still be claimed.

Two requirement moves are automatic: the first task to start moves an ASSIGNED requirement to IN_PROGRESS, and when every related task is completed or cancelled an IN_PROGRESS requirement becomes COMPLETED.

## Agent

The `coordinator` bundle has five tools: `devboard_board` (read-only), `devboard_create_requirement`, `devboard_create_task`, `devboard_transition` and `devboard_request_human`, plus the `devboard-playbook` skill. Tools and pages share one profile-scoped store, so what the agent writes is what the pages read.

## Layout

- `domain.mjs`: state machines, linkage, overdue derivation, seed data, reset; no host imports.
- `index.mjs`: profile services `devboard.snapshot`, `devboard.transition`, `devboard.create`, `devboard.reset`; agent tools and skill.
- `client/`: the four pages, built with `@agnes/web-ui`.
- `test/domain.test.ts`: state-machine, linkage, ordering and reset tests.

```sh
pnpm exec vitest run examples/showcase/devboard/test/domain.test.ts --maxWorkers=1
```

To try it from source, follow [installation](../../../docs/guide/install.md), open the Agents page, install DevBoard, then adopt it.
