# Acme 参考应用

[English](README.md) | 简体中文

一个插件交付工具、智能体和应用：`acme_status` 只返回模拟状态；`desk` 是带显式 launch 的 Bundle，使用宿主默认 Loop 和 Demo，并将工具范围明确限制为 `acme_status`；`application` 提供 Acme 品牌、Ava 助手名、PNG 标志／favicon、概览页面与导航默认值。只导入公开合同，不修改 Core，也不接触客户系统。

## 部署者采用流程

按[安装指南](../../docs/guide/install.zh-CN.md)构建当前源码。以下命令从源码仓根目录执行，用全新隔离 home，不使用真实账号或密钥。

```sh
export AGH_SOURCE="$PWD"
export AGH_HOME="$(mktemp -d /tmp/agh-acme.XXXXXX)"
export AGH_HOME="$(cd "$AGH_HOME" && pwd -P)"
export AGNES_PROFILE=local-dev
node agnes.mjs plugins add "$AGH_SOURCE/examples/acme"
node agnes.mjs daemon stop
node agnes.mjs serve --port 4198
```

`plugins add` 可能已启动同一 home 的 daemon，因此在选择 Web 端口前先执行上面的 `daemon stop`。若希望安装时复用选定的 origin，也可先在另一终端运行 `serve --port 4198`，再安装。所有终端须使用相同 home 和 profile。已有 daemon 的 origin 不同时，启动会按预期拒绝：`local daemon Web origin does not match the selected origin`；执行 `node agnes.mjs daemon stop` 后重新运行选定端口的 `serve` 即可恢复，不必删除 home 或修改鉴权配置。

审阅安装预览的能力、来源与完整性后确认；无人值守的合成试用可给 `plugins add` 加 `--yes`。安装／信任／启用只增加候选，不会改变当前应用。打开打印的地址，在 **设置 → 应用** 选择 Acme，检查同意预览后采纳：品牌与资产、主页、隐藏的自动化入口、可见／默认智能体、角色替换、来源／签名／完整性、依赖权限差异、影响范围和恢复方法。未声明接管角色，因此宿主导航和对话呈现保持可用；追加页面不替换侧栏。

SDK 也可以完成相同预览／CAS 采纳。新终端保留相同环境，从仓库根运行下面两条命令；第一条只输出预览。`@agnes/sdk` 使用源码预览依赖，不承诺 npm 发行。审阅后第二条用最新预览摘要与当前 revision 显式采纳；状态须为 `active`。

```sh
pnpm --filter @agnes/cli exec node --import tsx --input-type=module --eval "$(cat examples/acme/adopt.mjs)"
ACME_ADOPT=1 pnpm --filter @agnes/cli exec node --import tsx --input-type=module --eval "$(cat examples/acme/adopt.mjs)"
node agnes.mjs --new --agent '@acme/operations#desk' -p 'call acme_status'
```

预期工具结果为 `{"service":"acme-demo","status":"healthy","synthetic":true}`。启动草稿可由用户修改后正常提交，不会自动发送。日常从「智能体」页选择 Acme 运营助手；默认 Loop 无需额外安装。

## 恢复与升级

打开 **`/?admin`**：宿主恢复 bootstrap 在应用 JS、CSS、接管角色和导航之前运行，使用 AGH 品牌。该 URL 不授予管理权限。离线也能清除选择：

```sh
node agnes.mjs app clear --profile local-dev --json
node agnes.mjs daemon stop
```

清除仅移除展示选择，不撤权、不释放 pin、不改执行配置。在线走 CAS；离线使用相同锁与 revision。包被停用、撤权、移除或升级后摘要变化时，选择保留为 unresolved，展示回落 AGH，不会自动换另一个应用。更新须重新审阅信任与预览采纳。显式 URL > 用户偏好 > 应用默认 > 宿主默认；应用选择不会改旧会话的执行身份。Profile 页面跟随当前激活，会话渲染器跟随该会话固定代际。

PNG 资产是本项目原创的几何图形，按 Apache-2.0 分发。任意已信任 JavaScript 不是沙箱；隐藏入口不是权限控制。详见[应用合同](../../docs/extend/applications.zh-CN.md)。未做真实客户／模型、浏览器或跨平台验收。
