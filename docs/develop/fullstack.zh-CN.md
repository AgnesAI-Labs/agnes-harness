# 前后端联动：让面板读到业务结果

[English](fullstack.md) | 简体中文

[文档导航](../README.zh-CN.md) · 前提：[后端](backend.zh-CN.md)与[前端](frontend.zh-CN.md)

在官方 Web 工作台运行[显式采用的服务面板](../../examples/packages/approved-service-panel/package.json)。你将审阅应用，在真实会话中打开页签，并看到只读查询返回的 `backend 1.0.0`。示例使用模拟数据，无需模型账号。

<a id="运行前显式配置能力上限"></a>

## 启动隔离工作台

先[构建本地发行版](../guide/install.zh-CN.md)。在已构建的源码仓库中，为本次演练创建独立的 home 和工作目录，再启动 Web：

```sh
export AGH_SOURCE="$PWD"
export AGH_HOME="$(mktemp -d /tmp/agh-service-panel.XXXXXX)"
export AGH_HOME="$(cd "$AGH_HOME" && pwd -P)"
export AGNES_PROFILE=local-dev
export AGH_DEMO_WORKSPACE="$(mktemp -d /tmp/agh-service-panel-work.XXXXXX)"
printf 'AGH_SOURCE=%s\nAGH_HOME=%s\nWorkspace=%s\n' "$AGH_SOURCE" "$AGH_HOME" "$AGH_DEMO_WORKSPACE"
mise exec -- node agnes.mjs serve --cwd "$AGH_DEMO_WORKSPACE" --port 4198
```

在独立的浏览器配置中打开命令输出的本地地址。默认 `local-dev` 配置允许 `services`。如果自定义部署不允许，请停止演练，不要为教程放宽策略。

## 安装并审阅应用

1. 在第二个终端，把下面两处路径替换为第一个终端打印的实际路径，再从源码安装。市场不会自动上架这个教程包。保留该终端用于清理。

   ```sh
   export AGH_SOURCE='/absolute/path/to/agnes-harness'
   export AGH_HOME='/tmp/agh-service-panel.your-suffix'
   export AGNES_PROFILE=local-dev
   cd "$AGH_SOURCE"
   mise exec -- node agnes.mjs plugins add "$AGH_SOURCE/examples/packages/approved-service-panel"
   ```

2. 审阅来源、完整性摘要和所需能力，再确认安装、信任并启用。此时后端可以运行，但官方工作台不会加载原生客户端或显示页签。信任插件不等于批准其原生界面。
3. 在隔离浏览器中打开工作台。在首次运行引导中选择 **Demo**，再选中刚创建的临时工作目录。
4. 打开**设置 → 应用**，预览本教程的候选应用。由于没有声明品牌，候选项显示官方名称 **Agnes Harness**。展开**技术详情**，核对 `packageId` 为 `@agnes-examples/approved-service-panel`、版本为 `1.0.0`，且来源和完整性摘要与安装时一致。
5. 检查 `declaration.workbench.tabs` 只有一个 `page` 页签，指向 `@agnes-examples/approved-service-panel#service-version`，且 `replacedRoles` 为空。示例不更改官方首页、导航、皮肤或默认智能体。核对无误再点击**采用**。每个 profile 同一时间只能采用一个应用，不要在需要保留现有应用的 profile 中演练。

## 在会话中读取结果

1. 新建对话，发送一条无副作用的消息，例如 `查看服务面板教程`，等待 Demo 回复。请在启用插件后创建会话，使其后端代次包含本示例。
2. 打开右侧**工作台**，选择**服务版本**。如果页签折叠，请在**更多**中查找。会话就绪且后端返回结果后，页面显示 `backend 1.0.0`。
3. 保持该会话选中并刷新页面，必要时重新打开页签。再创建第二个 Demo 对话，在两个会话之间切换。页面会等待所选会话就绪并重新读取。如果当前会话不可用，页面不能显示其他会话的结果。

<a id="结构与调用链"></a>
<a id="后端与前端各声明一次"></a>

## 在源码中追踪调用

- [包声明](../../examples/packages/approved-service-panel/package.json)只声明一个后端 Cordis 行。`agnes.clientDescriptors` 通过相同的 `rowId` 绑定 [profile 客户端描述](../../examples/packages/approved-service-panel/client/agnes.client.json)。工作台页签引用描述中的 `homeEntries` 页面，不声明全局槽位，也不替换界面角色。
- [后端入口](../../examples/packages/approved-service-panel/index.mjs)通过 `ctx.services.register()` 注册 `approved.panel.version`。该会话查询接收空对象，返回含版本字符串的对象，并限制超时和结果大小。查询不写入数据，也不访问外部系统。`ctx.provide()` 本身只发布本地 Cordis 依赖。
- [页面](../../examples/packages/approved-service-panel/client/index.js)通过同源浏览器桥接调用 `ctx.agnes.services.call('approved.panel.version', {})`。客户端描述只允许这个服务名。daemon 先核对获准的客户端行及服务归属，Host 再检查所选会话并调用处理函数。页面不会获得 daemon 凭据或 Host 授权。
- 页面订阅会话就绪状态和客户端贡献的可用状态。仅在会话就绪时查询，也只展示与当前两份状态快照对应的结果。页签卸载时退订，丢弃尚未完成的结果。

<a id="失败与清理"></a>

## 恢复官方界面

如果会话已就绪但显示**服务不可用**，检查包是否仍启用、应用是否仍处于采用状态。如果会话早于安装，请新建会话，不要修改旧会话的后端代次。

在隔离浏览器中打开工作台本地地址下的 `/?admin`，选择**恢复官方界面**。回到对话，按提示刷新。页签消失，官方工作台仍可用。恢复操作会清除该 profile 的应用选择和单独设置的界面选择，但不会停用包或修改已保存的会话。恢复地址本身不授予权限。

如果 Web 无法打开，用第二个终端清除应用选择。如果已在 Web 中**恢复官方界面**，跳过清除命令。保留隔离 home 的环境变量，再单独停用插件：

```sh
mise exec -- node agnes.mjs app clear --profile local-dev
mise exec -- node agnes.mjs plugins disable @agnes-examples/approved-service-panel
```

在第一个终端按 Ctrl-C 停止 `serve`。再回到第二个终端，运行 `mise exec -- node agnes.mjs daemon stop` 停止本次隔离 daemon。

如果启动 Web 时提示 daemon 的来源地址不同，仅停止本次隔离 home 下的 daemon，再重试原 `serve` 命令。不要通过修改信任或准入设置来显示示例。完整合同见[应用采用与恢复](../extend/applications.zh-CN.md)。

<a id="验证命令"></a>

## 检查旧版服务测试样本

[v1](../../examples/packages/client-service-panel/v1/package.json) 和 [v2](../../examples/packages/client-service-panel/v2/package.json) 是独立测试样本，用于覆盖后端版本、会话代次固定和撤权。它们不提供可采用的应用页面，普通安装不会让其原生界面进入官方工作台。可继续运行这些 API 和生命周期测试：

```sh
mise exec -- node tools/toolchain/run.mjs exec vitest run tools/public-docs/examples.test.ts packages/host/test/assemble/dynamic-client-extension.test.ts packages/daemon-admin/test/client-modules.test.ts --maxWorkers=1
```

这些测试覆盖样本注册和授权，不能替代上面的真实浏览器步骤。会话以外的操作请参阅 [Profile 服务与持久通知](profile-services.zh-CN.md)。
