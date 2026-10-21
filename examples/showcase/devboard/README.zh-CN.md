# DevBoard 研发智能体看板

[English](README.md) | 简体中文

研发多智能体协作任务看板的概念验证（POC）应用，用于演示，不是生产系统。**所有数据均为虚构的合成数据**，不连接任何外部系统。

在智能体页安装并采纳 DevBoard 后，工作台出现四个页面和一个「研发协调员」智能体：

| 页面 | 内容 |
| --- | --- |
| 总览 | 需求、任务、人工介入请求的各状态计数，最近动态，以及「重置演示数据」。 |
| 需求 | 按状态过滤；详情页展示关联任务与流转记录，可细化、打回、分配等。 |
| 任务 | 按状态和类型过滤；列表或看板（按状态分列）视图；开始、完成、失败、重试、阻塞、解除、取消。 |
| 人工介入 | 超时项红色标识并置顶，其余按创建时间倒序；认领、放弃认领、处理完成；按类型过滤。 |

看板每 10 秒轮询一次，智能体写入的变化无需手动刷新即可看到。页面顶部的「演示角色」（管理者、协调员、工程师、质量安全）只用于操作署名，并对工程师隐藏认领按钮，不是安全边界。

## 状态机

所有写入都走同一个流转函数，表外的流转一律拒绝，提示「非法状态流转：A 不可流转至 B」。

- 需求：RAW → REFINED；REFINED → RAW / ASSIGNED；ASSIGNED → REFINED / IN_PROGRESS；IN_PROGRESS → BLOCKED / COMPLETED；BLOCKED → IN_PROGRESS。
- 任务：PENDING → IN_PROGRESS / BLOCKED / CANCELLED；IN_PROGRESS → COMPLETED / FAILED / BLOCKED；BLOCKED → IN_PROGRESS / CANCELLED；FAILED → PENDING / CANCELLED。
- 人工介入：OPEN → CLAIMED；CLAIMED → OPEN / RESOLVED。OPEN 且超过截止时间时读作 EXPIRED（读取时推导，不跑定时器），仍可认领。

需求有两条自动联动：首个关联任务开始时 ASSIGNED → IN_PROGRESS；全部关联任务完成或取消时 IN_PROGRESS → COMPLETED。

## 智能体

`coordinator` 包含五个工具：`devboard_board`（只读）、`devboard_create_requirement`、`devboard_create_task`、`devboard_transition`、`devboard_request_human`，以及技能 `devboard-playbook`。工具和页面共用同一个档案级存储，智能体写入的内容就是页面读取的内容。

## 目录

- `domain.mjs`：状态机、联动、超时推导、种子数据、重置，不依赖宿主包。
- `index.mjs`：档案服务 `devboard.snapshot`、`devboard.transition`、`devboard.create`、`devboard.reset`，智能体工具与技能。
- `client/`：四个页面，使用 `@agnes/web-ui` 组件。
- `test/domain.test.ts`：状态机、联动、排序与重置测试。

```sh
pnpm exec vitest run examples/showcase/devboard/test/domain.test.ts --maxWorkers=1
```

从源码试用请按[安装](../../../docs/guide/install.zh-CN.md)准备环境，打开智能体页安装 DevBoard 后采纳。
