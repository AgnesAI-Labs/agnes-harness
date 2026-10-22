# 车门健康监测看板

宁川装备（虚构企业）的演示项目：模拟 PHM 信号，按线路、车辆、车门三级展示健康评分，并列出预警排行。无依赖，不访问外网。

## 运行

```
node server.js
```

在 AGH 中服务接管 Host 交接的监听器（`AGH_LOOPBACK_FD`），并输出 `AGH_LOOPBACK_URL`；普通部署用 `node server.js --port 5180`。

## 测试

```
node --test
```

18 个单元测试，不需要监听端口。HTTP 与浏览器验收见 `docs/ACCEPTANCE.md`。

## 目录

| 路径 | 说明 |
|---|---|
| server.js | 启动入口 |
| src/signals.js | 模拟信号 |
| src/health.js | 评分、等级、排行 |
| src/app.js | 路由与参数校验 |
| src/page.js | 页面 |
| test/ | 单元测试 |
| docs/ | 计划、需求、追溯、设计、测试报告、验收记录、发布说明 |
