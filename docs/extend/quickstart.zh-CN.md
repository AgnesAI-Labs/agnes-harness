# 五步写出第一个插件（第 5 步可选）

[English](quickstart.md) | 简体中文

[作者工具包](README.zh-CN.md) · [本地插件](local-plugins.zh-CN.md) · [测试指南](testing.zh-CN.md) · [导入选择图](imports.zh-CN.md)

需要 Node.js 24.10 或更新版本，并按[安装指南](../guide/install.zh-CN.md)准备 AGH 源码运行环境。最短路径使用本地 TypeScript 插件和内置免密钥 **Demo（本地工具演示，免 API key）**模型，不需要构建插件、连接 SDK 或配置 API key。

准备独立 home 和工作区（不计入产品命令步骤）。后续命令使用相同环境和工作区；`pwd -P` 避免 macOS `/tmp` 等父目录符号链接触发 home 安全检查。第 1–4 步各一条必需命令，第 5 步为可选验证；首次成功共 4 条产品命令。

```sh
export AGH_SOURCE="/absolute/path/to/agnes-harness"
export AGH_HOME="$(mktemp -d /tmp/agh-author.XXXXXX)"
export AGH_HOME="$(cd "$AGH_HOME" && pwd -P)"
export AGNES_PROFILE=local-dev
AGH_WORKSPACE="$(mktemp -d /tmp/agh-workspace.XXXXXX)"
cd "$AGH_WORKSPACE"
```

## 1. 创建插件父目录

```sh
mkdir -p .agh/plugins
```

<a id="1-直接创建到插件目录"></a>

## 2. 生成工具插件

```sh
node "$AGH_SOURCE/templates/create-agh-plugin.mjs" tool hello-tool .agh/plugins/hello-tool --local
```

包入口是 `./src/index.ts`。AGH 用 jiti 按需转译，并提供公共作者 SDK 和 TypeBox。本教程将插件保留在 daemon 启动工作区内；`dev` 拒绝工作区外的路径。每个终端使用同一 home。本地目录意味着选择信任并执行其中代码，只放你愿意运行的插件。

工具模板声明 `agnes.provides: ["tool"]` 与 插件条目上的 `capabilities: {}`，预览无需执行代码即可展示类型与请求的能力范围。新增功能或副作用时请更新这些声明；面板模板声明 UI 与 owner store 能力，Loop 模板声明模型能力。能力字段的完整格式和示例见[声明能力](../guide/packages.zh-CN.md#能力声明)；空对象适合此纯回声工具，增加文件、网络或进程访问前应按实际范围声明。

<a id="2-启动-agh"></a>

## 3. 激活插件

`dev` 会按需启动此 home 的 daemon。

```sh
node "$AGH_SOURCE/agnes.mjs" dev .agh/plugins/hello-tool --profile local-dev
```

<a id="3-调用工具"></a>

## 4. 调用工具

```sh
node "$AGH_SOURCE/agnes.mjs" --new -p 'call plugin_hello_tool'
```

CLI 和 daemon 仅在没有已保存 profile 或显式 provider 配置的全新 local-dev 安装中选择教学回退 route `demo`、model `demo-model`。它是确定性的免联网教学模型：点名可用工具后，按 schema 生成示例参数并调用，再展示真实结果。也可直接提交 `call plugin_hello_tool {"message":"hello"}`。无法构造合法参数时会提示修正；可选的启用检查见第 5 步；推理任务请配置真实模型。

`--new` 用最新插件代际创建新会话，print 模式在 stderr 显示会话 key。普通 `agh -p` 仍复用工作区会话。用 `agh tools --session <key>` 查看指定会话，加 `--json` 输出 schema 和来源。SDK 使用 `await session.tools()`；本地 admin API 使用 `GET /admin/api/tools/<编码后的会话 key>`。

## 5. 可选验证：检查工具

```sh
node "$AGH_SOURCE/agnes.mjs" tools
```

## 其他可选验证：status / Web

```sh
node "$AGH_SOURCE/agnes.mjs" package status --json
# 可选：启动 Web 界面
node "$AGH_SOURCE/agnes.mjs" web
```

Web 中新建会话，选择 **Demo (local tool-aware, no API key)**，提交 `call plugin_hello_tool`。已有显式模型配置优先。要求 Demo 创建插件时，它会使用可用的 `plugin_helper_guide` 和 `plugin_helper_create`；仍需审核生成的文件，并单独批准安装。若只有内置 creator，可调用 `plugin_creator_guide` 和 `plugin_scaffold` 创建固定的工具示例，然后停止等待审核。

<a id="4-修改并重试"></a>

## 修改并重试（首次成功之后）

在工作区编辑 `.agh/plugins/hello-tool/src/index.ts`，例如在返回结果前加上 ``message = `hot-v2:${message}` ``。再次提交 `call plugin_hello_tool {"message":"hello"}`，新会话应返回 `hot-v2:hello`。保留 `ctx.signal.throwIfAborted()`，异步操作传入 signal。预期业务拒绝用 `toolError('message')`；客户端和订阅通过 `ctx.effect()` 释放。

运行中的 daemon 会发现新本地目录并监听修改；普通插件改动无需重启，会激活新代际。在 `/admin/plugins` 检查启用错误，也可立即请求重载：

```sh
node "$AGH_SOURCE/agnes.mjs" dev .agh/plugins/hello-tool --profile local-dev
node "$AGH_SOURCE/agnes.mjs" plugins reload hello-tool --profile local-dev
```

激活后在 Web 创建新会话或使用 `agh --new -p`，客户端面板资源随新代际更新。已有会话（包括同一工作区中复用的 CLI 会话）仍保持原代际。存储、沙箱等进程后端仍需重启。详见[热重载](hot-reload.zh-CN.md)与[本地插件](local-plugins.zh-CN.md)。

修改工具结果后，也将 `test/plugin.test.mjs` 的成功结果断言更新为 `{ message: 'hot-v2:hello' }`，保留无效输入、取消与卸载断言。

<a id="5-可选的构建和测试"></a>

## 可选的构建和测试

需要编译或运行作者测试时，在仓库内构建一次预览 SDK 声明，再本地链接。预览 Agnes SDK 尚未发布到 npm，无需从注册表安装：

```sh
AGH_PLUGIN="$PWD/.agh/plugins/hello-tool"
cd "$AGH_SOURCE"
mise exec -- node tools/toolchain/run.mjs exec tsc -b packages/plugin-runtime packages/protocol packages/resource-control-runtime
node templates/link-local.mjs "$AGH_PLUGIN"
npm --prefix "$AGH_PLUGIN" run build
npm --prefix "$AGH_PLUGIN" test
```

linker 可重复执行。model-adapter 模板使用公共合同测试数据，不再要求构建 `@agnes/ai`。需要安装编译包时，不带 `--local` 创建、构建后按[插件管理](../guide/packages.zh-CN.md)安装。追加页面选 `tool-with-panel`，独立循环选 `loop`。

## Host 提供的依赖

模板在 `package.json` 声明 SDK 需求：

```json
{
  "agnes": {
    "hostProvidedExternals": {
      "@agnes/plugin-runtime": "0.0.0",
      "@agnes/extension-api": "^5.0.0",
      "@sinclair/typebox": "~0.34.0"
    }
  }
}
```

该字段可选，按精确的公共模块名声明兼容版本。范围语法同扩展 `apiRange`：精确版本、`*`、`^`、`~`、空格连接的比较条件和 `x` 通配；不支持范围并集或预发布版本。AGH 在执行模块前校验。

Host 提供 `@agnes/plugin-runtime` 作者导出、`@agnes/extension-api`、`@agnes/protocol`、`@agnes/observability/contract`、`@agnes/intelligent-ui-contract`、`@agnes/git-worktree-contract`、`@agnes/plugin-runtime/deferred-contract`、`@agnes/cordis`、`@sinclair/typebox` 及其 `/value`、`/compiler` 子路径，不提供 Host 内部或 testkit。安装快照和本地插件共用这些公共命名空间。请从这些合同路径导入 kind token，保持 loader 重载前后的身份一致。

其他依赖由作者打包，或放入包自身声明的依赖树。本地发现不安装依赖，源码快照省略 `node_modules`，所以复制插件前执行 npm install 不足以分发它。缺模块错误指出依赖并建议打包／安装；版本错误提示调整 SDK 范围或升级 AGH。

## 清理试用环境

结束后停止 daemon 和运行 `web` 的终端，再删除自己创建的临时目录。

```sh
node "$AGH_SOURCE/agnes.mjs" daemon stop
# 若启动过 Web，在 web 终端按 Ctrl-C。
rm -rf "$AGH_HOME" "$AGH_WORKSPACE"
```

分阶段业务 Agent 使用 `--template loop`，从 [`defineWorkflowLoop`](workflow-loops.zh-CN.md) 开始，只写业务阶段，由官方 helper 负责确认、checkpoint 与审批续接。
