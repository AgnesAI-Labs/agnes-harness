# 云端工作台对接预览

[English](remote-frontend.md) | 简体中文

[文档](../README.zh-CN.md) · [安装](install.zh-CN.md) · [插件](packages.zh-CN.md) · [凭据](credentials.zh-CN.md)

本指南适用于提供**设置 → 高级 → 云端连接**的 Harness 部署。请向部署方获取两端配套的 Harness 构建和兼容的云端插件包。本文所述集成使用 Harness Extension API `5.23.0`。

本地工作台（A）提供浏览器界面并管理本地凭证。远程 Harness（B）管理云端会话、工作区、模型、工具和审批。仅 B 需要云端插件。工作台同时支持一个云端连接。

设置中的诊断跟随用户选定的本地／云端执行环境；云端不可达时显示失败，不会静默改为导出本机诊断。账户等管理页面仍由 A 提供。对于按凭据自动发现的云端连接，离线后最多重新发现 8 次，每次等待不超过 25 秒，退避间隔最高 30 秒；鉴权拒绝（包括 401）也计入此预算，不授予访问能力；凭据不存在、授权响应无效或达到上限时停止，可手动重新连接。发现实例地址变化时重新鉴权并恢复已选会话，不重放创建、发送或工具请求。在 A 的凭据页成功替换当前云端凭据的密钥值后，工作台会重新鉴权并恢复云端会话选择；仍由 A 管理凭据，修改其他凭据或仅重命名不会触发重连。若新密钥无效，连接显示失败，可修正后重试。

## 配置远程 Harness

使用托管沙箱时，由部署方准备 B 并开通实例。从源码部署时，按[安装指南](install.zh-CN.md)准备各平台的依赖。在支持本功能的源码根目录中，macOS、Linux 和 Windows PowerShell 使用同一条构建命令。

```sh
mise exec -- node tools/toolchain/run.mjs --filter @agnes/cli build:local
```

在启动 B 的 daemon 和 Worker 前配置服务环境，通过服务的密钥配置注入部署 Key。将下方保留域名换成实际模型网关。长期运行的服务应把变量设置在服务环境中。已有部署修改环境后，按部署流程重启 daemon 和 Worker。

macOS 和 Linux

```sh
export AGH_CLOUD_API_BASE_URL='https://models.example.com/v1'
```

Windows PowerShell

```powershell
$env:AGH_CLOUD_API_BASE_URL = 'https://models.example.com/v1'
```

| 配置 | 用途 |
| --- | --- |
| `AGH_CLOUD_KEY` | 部署 Key。配套插件也接受 `AGH_API_KEY`，同时设置时两者值须一致。 |
| `AGH_CLOUD_API_BASE_URL` | 模型网关基地址。配套插件也接受 `OPENAI_BASE_URL`，同时设置时两者值须一致。 |
| `LLMSG_TRACK_URL` | 用量上报的完整 URL。未设置时插件使用模型网关同源的 `/llmsg/api/track/tool_calls`。 |

LLMSG 启动入口要求 `AGH_CLOUD_API_BASE_URL` 和 `LLMSG_TRACK_URL` 均非空。首次启动时，Core 初始化新空目录或仅含有效 `$AGH_HOME/cloud-key` 的新目录。Key 文件优先。文件缺失时，设置 `AGH_CLOUD_KEY` 或 `AGH_API_KEY`，同时设置时两者的值须一致。插件安装成功后，入口只在文件仍然缺失时创建私有 Key 文件。请使用启动脚本与 Harness 运行包配套构建的镜像。旧版或其他无法识别的未标记非空目录仍会被拒绝。

实际部署使用 HTTPS 模型网关。基地址接受 HTTP(S)，可包含 `/v1` 等 API 路径，不能包含账号密码、查询字符串或片段。插件规范末尾斜杠，拼接 `models` 发起 GET，拼接 `chat/completions` 发起兼容 OpenAI 的 POST/SSE。两者均使用部署 Key 作为 bearer 凭证。

**向客户端开放 B 前，先配置 HTTPS/WSS。** 可以在 B 上[配置发布接口的 TLS](#发布与授权接口)，也可以使用支持 WebSocket 升级的 HTTPS 入口。使用 HTTPS 入口时，B 的后端监听只供入口访问。在部署网络内验证 HTTPS 和 WSS 可用后，再向远程客户端开放。只有在可信的隔离测试网络中，客户端才使用明文 HTTP/WS 和测试 Key。

将部署方提供的插件包放在当前目录并命名为 `agh-cloud-plugin.tgz`，也可以填写实际路径。在任一 Shell 中使用配套的已安装 `agh` CLI。从已构建的源码目录运行时，把 `agh` 替换为 `mise exec -- node agnes.mjs`。确认安装、信任和激活前，检查插件来源和权限。两条命令使用相同的 home、profile 和服务环境。

```sh
agh plugins add "./agh-cloud-plugin.tgz"
agh serve
```

升级 B 和插件后，请新建云端会话。符合条件的已有会话可在运行时设置中迁移到当前插件版本。如果插件提供 `imageModels`，只填写已通过该网关验证支持图片的模型 ID。

## 从本地工作台连接

1. 在 A 上用 `agh serve` 启动配套构建，打开命令输出的本地地址。
2. 打开**设置 → 权限 → 凭据**，用已开通的 LLMSG 沙箱签发的 Key 创建一条通用凭证。请勿在 URL、命令历史或日志中记录 Key。
3. 打开**设置 → 高级 → 云端连接**，选中该凭证并点击**保存并连接**。**管理本地凭证**打开 A 的凭据页，**刷新凭证列表**重新加载选项。
4. 等待状态显示**已就绪**，在会话搜索下选择**云端**，点击 **+** 新建会话，确认模型和工作区属于 B。选择**本地**可返回 A 的会话。A 侧栏的管理入口打开 A 的设置。管理 B 请使用 B 自己的工作台。

连接页按所选凭证自动查找沙箱，没有手动地址输入项。旧的 `?remote=` 链接可显式选择后端来源，需要同一浏览器已为该来源保存凭证绑定。普通直连来源形如 `https://harness.example.com:8443`。首次使用的浏览器应在支持发现服务的部署上按上述凭证流程连接。请勿在链接中填写 Key 或临时连接凭证。

需要使用部署专用发现服务时，在 **A 的 daemon 环境**中将 `AGH_LLMSG_API_BASE_URL` 设为部署方提供的 HTTPS 来源，例如 `https://broker.example.com`。只填写协议、主机和可选端口，重启 A 的 daemon 后生效。此变量与 B 的模型网关基地址分别配置。显式配置无效或无法访问时，仍以该配置为准。

A 的 daemon 以托管的 LLMSG Key 作为 bearer 凭证，发送请求体为 `{}` 的 `POST /llmsg/api/agh/connection`。发现服务查询已开通的沙箱，返回绑定的 HTTPS 来源和平台流量令牌。令牌只保留在 A 的 daemon 和 launcher 中，用于转发已获授权的沙箱流量。凭证被拒时检查 Key。HTTP 409 表示沙箱不可用。遇到 HTTP 429 时，等待限流解除后再连接。

工作台地址会保留打开的本地页面或设置，以及本地草稿选定或技能页链接指定的工作区。刷新可恢复原位置。浏览器前进和后退会打开历史地址里的本地页面或云端会话。新建云端会话后刷新，仍会停在草稿界面。即使在云端刷新后，切回本地也会恢复离开前的页面；重连同一个云端部署会恢复选中的云端会话。

主动断开会清除当前连接，保留已保存的凭证。云端中断时可以继续使用本地会话。远程访问受浏览器的专用网络、混合内容和证书规则约束。HTTPS 页面需要兼容的安全端点。

## 发布与授权接口

B 上受信任且已启用的插件在客户端描述符中声明 profile 级查询 `frontend.publish`。它接收 `{}`，结果结构如下。校验值是部署 Key 的 SHA-256 摘要，用 64 位小写十六进制字符表示。

```json
{
  "enabled": true,
  "access": "key-owner",
  "host": "0.0.0.0",
  "port": 8443,
  "auth": { "keySha256": "<64 lowercase hexadecimal characters>" }
}
```

`host` 是监听绑定地址。客户端使用 HTTPS 端点的可达主机名。由 B 提供 TLS 时，`tls.certFile` 和 `tls.keyFile` 须分别指向 B 上的证书和私钥文件。省略这两个字段时，发布监听使用 HTTP/WS。B 的本地 Web 界面使用独立的监听。

- 浏览器向 A 的同源 `POST /_agnes/cloud-connection/authorize` 提交凭证引用。有明确的后端来源时同时提交该来源。A 的 daemon 取出 Key，向 B 的 `POST /_agnes/remote-frontend/auth` 提交 `{key}` 完成交换。
- B 签发有效期为八小时的临时连接凭证。元数据、HTTP API、插件资源及 WebSocket 升级使用 `/_agnes/remote-access/<capability>/…` 前缀。该前缀下，`/_agnes/remote-frontend` 返回受保护的元数据，`/_agnes/remote-frontend/ws` 接收 WebSocket 升级请求。请勿在日志或示例中写入完整连接 URL。
- 普通直连使用 B 的 HTTP/WebSocket 监听。LLMSG 连接经 A 的隔离服务转发，平台流量令牌留在 A 的后端。两端配套构建须为云端浏览器流请求保留 `x-agnes-stream-open: 1`，并执行正常鉴权。
- `key-owner` 授予持有者 B 当前 profile 的完整工作台权限，工具审批仍适用。需要隔离用户身份或租户时，请使用独立部署。停用发布插件或关闭 launcher 会停止发布。

## 工具用量上报

启用用量上报的部署须同时使用配套 Core 和云端插件。插件以模型网关的 bearer 凭证向上报 URL 发送 `POST`，请求体包含取自模型响应头 `X-Oneapi-Request-Id` 的 `request_id`，以及工具名到次数的映射 `tool_calls`。

只统计云端模型路由下成功的工具调用。配套插件使用 Core 提供的可信派发证据，去重内部重试，在异步工具最终成功后计数。请求有待定结果时，上报会等待完整次数。遇到暂时性发送失败，重试沿用原请求 ID 和次数。`cloudusage.check` 返回排队、阻塞和已发送的数量。部署重启时应保留插件持久化状态，以恢复待上报记录。
