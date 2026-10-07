# 五分钟写出第一个插件

[English](quickstart.md) | 简体中文

[作者工具包](README.zh-CN.md) · [本地插件](local-plugins.zh-CN.md) · [测试指南](testing.zh-CN.md)

需要 Node.js 24.10 或更新版本，并按[安装指南](../guide/install.zh-CN.md)准备 AGH 源码运行环境。最短路径使用本地 TypeScript 插件和内置免密钥 **Demo（本地脚本回复）**模型，不需要构建插件、连接 SDK 或配置 API key。

## 1. 直接创建到插件目录

在将要启动 daemon 的工作区执行。源码预览的脚手架命令从 AGH 仓库运行：

```sh
mkdir -p .agnes/plugins
node templates/create-agh-plugin.mjs tool hello-tool .agnes/plugins/hello-tool --local
```

包入口是 `./src/index.ts`。AGH 用 jiti 按需转译，并提供公共作者 SDK 和 TypeBox。也可以放到 `$AGH_HOME/plugins/hello-tool`，每个终端使用同一个配置 home。本地目录意味着选择信任并执行其中代码，只放你愿意运行的插件。

工具模板声明 `agnes.kinds: ["tool"]` 与 `agnes.capabilities: {}`，预览无需执行代码即可展示类型与请求的能力范围。新增功能或副作用时请更新这些声明；面板模板声明 UI 能力，Loop 模板声明模型能力。

## 2. 启动并打开新会话

```sh
AGNES_PROFILE=local-dev agh web
```

源码环境尚无 `agh` 命令时，按安装指南完成一次运行时构建，用 `node packages/cli/dist/local/agnes.mjs` 替代它。

保持 daemon 运行，在另一个使用相同工作区、profile 和 home 的终端执行：

```sh
AGNES_PROFILE=local-dev agh -p 'hi'
```

全新 local-dev 默认选择 route `demo`、model `demo-model`，回复明确标记为 Demo。它通过真实会话循环返回固定教学回复。在 `/admin/plugins` 或 `agh package status` 检查 hello-tool 的启用状态。模板注册的工具名是 `plugin_hello_tool`；后端启用本身不代表模型已调用工具。要演示选工具，可配置含工具调用回复的 scripted route 或真实模型；下方可选作者测试能免模型调用工具。

Web 中新建会话，选择 **Demo (local scripted reply, no API key)**，提交 `hi`。这是教学模型；推理和自动选工具需要配置真实模型。已有显式模型配置优先。

## 3. 修改并重试

修改 `src/index.ts`。保留 `ctx.signal.throwIfAborted()`，异步操作传入 signal。预期业务拒绝用 `toolError('message')`；客户端和订阅通过 `ctx.effect()` 释放。

运行中的 daemon 会发现新本地目录并监听修改；普通插件改动无需重启，会激活新代际。在 `/admin/plugins` 检查启用错误，也可立即请求重载：

```sh
agh dev .agnes/plugins/hello-tool --profile local-dev
agh plugins reload hello-tool --profile local-dev
```

激活后在 Web 创建新会话使用它。已有会话（包括同一工作区中复用的 CLI 会话）仍保持原代际。存储、沙箱等进程后端仍需重启。详见[热重载](hot-reload.zh-CN.md)与[本地插件](local-plugins.zh-CN.md)。

## 4. 可选的构建和测试

需要编译或运行作者测试时，在仓库内构建一次预览 SDK 声明，再本地链接。预览 Agnes SDK 尚未发布到 npm，无需从注册表安装：

```sh
nice -n 10 pnpm exec tsc -b packages/plugin-runtime packages/protocol packages/resource-control-runtime
node templates/link-local.mjs .agnes/plugins/hello-tool
npm --prefix .agnes/plugins/hello-tool run build
npm --prefix .agnes/plugins/hello-tool test
```

linker 可重复执行。model-adapter 模板使用公共合同测试数据，不再要求构建 `@agnes/ai`。需要安装编译包时，不带 `--local` 创建、构建后按[插件管理](../guide/packages.zh-CN.md)安装。侧栏选 `tool-with-panel`，独立循环选 `loop`。

## Host 提供的依赖

模板在 `package.json` 声明 SDK 需求：

```json
{
  "agnes": {
    "hostProvidedExternals": {
      "@agnes/plugin-runtime": "0.0.0",
      "@agnes/extension-api": "^1.4.0",
      "@sinclair/typebox": "~0.34.0"
    }
  }
}
```

该字段可选，按精确的公共模块名声明兼容版本。范围语法同扩展 `apiRange`：精确版本、`*`、`^`、`~`、空格连接的比较条件和 `x` 通配；不支持范围并集或预发布版本。AGH 在执行模块前校验。

Host 提供 `@agnes/plugin-runtime` 作者导出、`@agnes/extension-api`、`@agnes/protocol`、`@agnes/cordis`、`@sinclair/typebox` 及其 `/value`、`/compiler` 子路径，不提供 Host 内部或 testkit。安装快照、本地插件与隔离扩展 runner 共用这些公共命名空间。

其他依赖由作者打包，或放入包自身声明的依赖树。本地发现不安装依赖，源码快照省略 `node_modules`，所以复制插件前执行 npm install 不足以分发它。缺模块错误指出依赖并建议打包／安装；版本错误提示调整 SDK 范围或升级 AGH。
