# 车门健康监测看板 软件架构设计说明书

> 虚构企业与模拟数据，仅用于 DevBoard 演示。

## 1 模块

| 设计条目 | 文件 | 职责 | 实现的需求 |
|---|---|---|---|
| DES-001 | src/health.js | 评分、等级、预警信号、排行、平均分 | SWR-001、SWR-002、SWR-004 |
| DES-002 | src/signals.js | 带种子的模拟信号生成，线路与车辆清单 | SWR-005 |
| DES-003 | src/app.js | 路由与参数校验，返回 JSON 或页面 | SWR-003、SWR-004、SWR-006 |
| DES-004 | src/page.js | 单页：三级钻取与排行，原生 DOM | SWR-003 |
| DES-005 | server.js | 启动服务：Host 交接的监听器或 `--port` | SWR-006 |

## 2 数据流

`signals.generate(seed)` 生成车门清单，启动时一次性放进内存；`app.createHandler(doors)` 返回请求处理函数；每个接口用 `health.js` 现算评分，不缓存、不写盘。

## 3 接口

| 方法与路径 | 说明 | 错误 |
|---|---|---|
| GET / | 页面 | — |
| GET /healthz | 存活与车门数量 | — |
| GET /api/lines | 线路及平均评分、等级 | — |
| GET /api/trains?line= | 线路下的车辆及平均评分 | 线路不存在 400 |
| GET /api/doors?line=&train= | 车门评分、等级、预警信号 | 线路或车辆不存在 400 |
| GET /api/ranking?limit= | 评分最低的前 N 扇门 | limit 非 1 至 50 的整数 400 |

其他方法返回 405，其他路径返回 404。

## 4 监听方式

`server.js` 读取 `AGH_LOOPBACK_FD`：有则接管 Host 预先绑定的监听器并输出 `AGH_LOOPBACK_URL`；没有则绑定 `127.0.0.1` 的 `--port`（默认 5180）。不自行设置这两个环境变量。

## 5 设计取舍

评分权重集中在 `WEIGHTS`，调整只改一个文件；页面不用框架，保持无依赖；为避免快速切换车辆时旧响应覆盖新结果，页面用递增序号丢弃过期响应（缺陷修复，见测试报告）。
