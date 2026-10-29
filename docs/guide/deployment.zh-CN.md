# 网络部署与代理

[English](deployment.md) | 简体中文

[文档导航](../README.zh-CN.md) · [安装与 Linux](install.zh-CN.md#linux-build) · [安全](security.zh-CN.md)

每个规范化 `AGH_HOME` 运行一个 App Server，客户端使用相同 home 与配置档。本地 Web 绑定回环地址，校验精确 Origin/Host。源码快速开始不是公网反向代理登录方案；加代理不会建立互联网用户认证。管理面保持私有。远程 SDK 传输需要其声明的 TLS/认证配置，并单独验收部署。

## 出站代理

在 daemon 启动环境设置代理，已有任务结束后停止并重启 daemon：

```sh
export HTTPS_PROXY=http://127.0.0.1:8080
export NO_PROXY=localhost,127.0.0.1
node agnes.mjs serve
```

示例假设你已运行这个代理。代理凭据不得出现在命令参数、截图或共享环境转储中。官方模型 HTTP 适配器、MCP HTTP/SSE、URL/npm/git 包下载与 OTLP HTTP 导出遵循代理配置。小写变量优先，包括显式空值；缺少 HTTPS_PROXY 时 HTTPS 回退 HTTP_PROXY。NO_PROXY 绕过匹配主机。社区适配器负责自己的传输，工作区 web_fetch 保留独立的公网策略。

## 超时与诊断

账号 **Base URL** 用于端点覆盖。可选账号/路由网络超时分别约束请求、连接建立与流空闲；留空保持默认。修改作用于新装配的会话，不改变已准入的在途请求。精确字段、范围与优先级见[配置参考](../reference/configuration.zh-CN.md)。

在同一源码根目录与 home 运行 `node agnes.mjs doctor network --json`，读取安全的代理主机/端口元数据。代理配置存在不证明模型或 MCP 已连接；显式测试账号/服务，再核对真实会话调用。默认 doctor 只做本地检查，`doctor --probe` 会联系模型服务，可能产生费用。

Linux 需安装原生依赖并核验 bubblewrap 命名空间实际可用，见 [Linux 安装](install.zh-CN.md#linux-build)与[诊断](troubleshooting.zh-CN.md#linux-diagnostics)。代理不放宽沙箱网络限制。Windows 完整端到端路径仍未验证。

源码合同：[网络配置](../../packages/protocol/schema/agnes-v1.json)、[App Server](../reference/app-server.zh-CN.md)、[诊断](observability.zh-CN.md)。
