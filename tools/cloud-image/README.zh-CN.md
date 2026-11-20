# 云端沙箱持久化对接文档

更新日期：2026-11-20。适用于包含 `tools/cloud-image/` 的云端分支构建；发布方须记录实际 Core 提交、插件提交与版本、镜像 digest。本文说明镜像与 LLMSG 的接入契约。

本镜像组合标准 Linux Harness、独立维护的云端插件、Litestream 0.5.18 和一个轻量备份管理进程。第三方继续负责分发、实例独占、CFS 分配、STS 签发和有效代次指针。本地模型执行与云端计费接口不变。

适用新持久化实例及本协议清单的历史恢复。旧沙箱的本地 home 不会自动迁入 COS；启用 COS 或更换模板前，平台须另行确认已有实例的数据保留与迁移方案，不得先回收旧实例。镜像发现未识别的非空 home 会报错，不通过清空旧目录绕过校验。

## 构建

通过 `node tools/toolchain/run.mjs` 使用仓库锁定的 Node 和 pnpm。运行包及原生扩展必须在 Linux amd64 中构建，不能复制 macOS 运行包。编译环境参考[原生构建器](../native/Dockerfile)和[安装指南](../../docs/guide/install.md)。

```sh
node tools/toolchain/run.mjs install --frozen-lockfile
AGNES_NATIVE_BUILDER=glibc228 node tools/toolchain/run.mjs --filter @agnes/host build:native
node integrations/llmsg/command-network.mjs "$PWD"
AGNES_NATIVE_BUILDER=glibc228 node tools/toolchain/run.mjs --filter @agnes/cli build:local --output-dir /ABS/CONTEXT/runtime
node /ABS/CONTEXT/runtime/agnes.mjs plugins pack /ABS/cloud-plugin /ABS/CONTEXT/cloud.tgz
```

将本目录的 `Dockerfile`、`.dockerignore`、`start.sh`、`install-litestream.sh`、`healthcheck.mjs`、`verify-plugin.mjs`、`THIRD_PARTY.md`、`sync/` 和 `bin/` 复制到构建上下文。默认插件版本为 `0.9.2-successful-tools.20261119.1`、要求 Extension API `^5.23.0`；构建参数必须与实际插件归档一致。镜像构建拒绝含 AppleDouble、Finder 元数据或异常根目录的插件归档。包校验、信任和启用仍由标准插件安装器负责。

```sh
docker build --platform linux/amd64 \
  --build-arg SOURCE_REVISION=SOURCE_COMMIT \
  --build-arg CLOUD_PLUGIN_VERSION=0.9.2-successful-tools.20261119.1 \
  -t agh-cloud:persistence /ABS/CONTEXT
```

镜像专用的 AWS SDK 使用独立 `sync/package-lock.json` 锁定，不增加本地 Harness 依赖。Litestream 二进制和上游许可证均校验 SHA-256。保留[依赖声明](THIRD_PARTY.md)及运行包许可证。构建上下文不得放真实 Key、STS、私有部署参数、本机 `node_modules` 或用户数据。

## 第三方注入参数

| 参数 | 约定 |
| --- | --- |
| `AGH_TENANT_ID`、`AGH_USER_ID` | 平台稳定标识，允许字母、数字、下划线和连字符 |
| `AGH_STATE_ID` | 此套状态的固定 UUID，接受 LLMSG 实际生成的 32 位十六进制形式及带连字符的 36 位形式；原值使用，不自行转换，不依赖 Key 或沙箱 ID |
| `AGH_STATE_PREFIX` | 稳定 COS 根前缀，如 `agh-state/example/1001/<state_uuid>`，首尾不带 `/` |
| `AGH_STATE_EPOCH` | 当前写入代次，正整数 |
| `AGH_STATE_INITIALIZED` | 首次严格为 `false`，有历史恢复时为 `true` |
| `AGH_RESTORE_FROM_EPOCH` | 首次为空字符串，恢复时为平台指定且小于当前写入代次的有效历史正整数代次 |
| `AGH_CLOUD_KEY` | 云端凭证；私有 `AGH_HOME/cloud-key` 文件存在时优先使用文件 |
| `AGH_CLOUD_API_BASE_URL` | 含 `/v1` 的云端模型服务地址 |
| `LLMSG_TRACK_URL` | 完整工具用量上报地址 |

默认目录：`AGH_HOME=/data/agh`（兼容 SQLite 的本地盘）、`WORKSPACE_DIR=/workspace/data`（用户 CFS）、`AGH_ASSETS_DIR=/data/agh-assets`（按 state 隔离的私有 CFS）、`AGH_SYNC_DIR=/run/agh-sync`（本地私有控制及凭证目录）。四者必须为互不嵌套的绝对路径。平台必须提前提供私有 CFS 挂载，镜像不创建替代挂载。UID/GID 保持 `0:0`，私有目录 `0700`，凭证文件 `0600`。平台仍需验证它确实是持久 CFS；目录存在不等于远端持久性已成立。

两个镜像入口 `/opt/agh/start.sh` 和 `/opt/agh/start-llmsg.sh` 使用同一脚本。先启动 envd。第三方应在 30 秒内写入 `/run/agh-sync/cos-sts.json`，通过同目录私有临时文件加原子 Move 替换：

```json
{
  "tmp_secret_id": "synthetic-id",
  "tmp_secret_key": "synthetic-secret",
  "session_token": "synthetic-token",
  "expired_time": 2000000000,
  "bucket": "example-state-bucket",
  "region": "ap-shanghai",
  "endpoint": "https://cos.ap-shanghai.myqcloud.com",
  "prefix": "agh-state/example/1001/11111111-1111-4111-8111-111111111111",
  "epoch": 2,
  "restore_from_epoch": 1
}
```

`expired_time` 使用 Unix 秒，JSON 代次字段使用整数；首次 JSON `restore_from_epoch` 为 `0`。首次恢复必须与 `AGH_RESTORE_FROM_EPOCH` 一致；恢复完成后，LLMSG 续期或唤醒时可将 JSON `restore_from_epoch` 置为 `0`，撤去不再需要的历史读取权限。只有本地身份及 epoch 标记通过校验后才接受该变化；不能换成其他历史代次。前缀、当前代次及存储位置必须保持一致。endpoint 为 HTTPS origin，不带凭证、查询串、路径后缀或自定义端口。管理进程每次请求清单前读取当前凭证，并受控轮换 Litestream，不重启 Harness。

LLMSG 的 CFS 目录初始化实例沿用专用 `WORKSPACE_DIR=/workspace/llmsg-cfs-init`，且不注入任何 `AGH_STATE_*`、租户/用户或恢复参数。此组合只启动 envd，供平台创建两条挂载对应的 subPath，不启动 Harness、不申请或读取 COS 凭证；若同时携带状态身份则拒绝。普通业务实例缺少身份仍会失败，不回退为空库或旧模式。

第三方保管长期 SecretId / SecretKey，用它们申请临时 STS 后，将 `tmp_secret_id`、`tmp_secret_key`、`session_token` 和 `expired_time` 写入上述文件。镜像只接受完整有效的临时凭证；缺失 token、缺失有效期或凭证过期均拒绝，不支持长期凭证回退，也不读取 `AGH_COS_STS_SECRET_ID` / `AGH_COS_STS_SECRET_KEY` 环境变量。

权限严格限制在当前 `<prefix>/epochs/<epoch>/` 的读写、列举及所需分块上传动作，以及指定历史恢复代次的只读和列举权限。镜像仅在当前代次下写 `manifest.json` 和 `databases/`，不选择数字最大的历史代次，不修改平台有效指针。替换实例开放写入前，平台必须同时阻止旧实例继续写 COS 和共享 CFS。

## 保存范围与普通文件目录清单

以下路径均相对 `AGH_HOME`：

| 本地路径 | 持久化方式 |
| --- | --- |
| `data/sessions.db` | Litestream，固定主库 |
| `data/tables/**/*.db` | Litestream 递归 Directory Watcher，并定期及停机扫描核对 |
| `data/artifacts/computer-use-ref-index.db` | Litestream，附件引用索引 |
| `home-layout.json`、`profiles/`、`data/profiles/`、`data/artifacts/`、`memory/` | 普通文件白名单，保存为私有 CFS 中的内容寻址对象 |

普通文件保存排除 SQLite、WAL/SHM/journal、`.lock`、`.tmp`、Litestream 临时副本目录、活动 `owner.json` 标记及临时 home 标记。特别是 `configuration-lock.sqlite` 和 `computer-use-artifact-mutation-lock.db` 不恢复。伪装成普通文件的 SQLite、符号链接和路径穿越均拒绝。平台当前 Key/STS、socket、daemon 状态、缓存、日志均不保存。第一版不保存用户额外配置的 `secrets/`、`auth/` 凭证，如需使用，应另行配置。工作区仍使用原有 CFS。

实现采用**本地普通文件工作副本**：将快照保存至私有 CFS `<assets>/objects/<hash前缀>/<SHA256>`，恢复时按清单回填 Harness 原有路径。这样不依赖容器内 bind mount 权限，也不引入私有路径校验会拒绝的符号链接。它不是 profiles/artifacts 的零拷贝挂载：冷启动耗时和本地空间随文件量增加；普通文件不会另传 COS。CFS 根目录 `state.json` 绑定 tenant/user/state。暂不自动清理对象，平台清理历史代次时需同步制定保留策略，不能删除仍被清单引用的文件。

单份清单上限为 16 MiB，数据库最多 10,000 个、普通文件最多 100,000 个；超限拒绝发布成功清单。每个代次的清单包括 `version`、`identity`、`epoch`、`complete`、`stopped`、`created_at`、数据库路径/Litestream TXID/schema user_version、普通文件路径/hash/大小/执行位，以及清单正文 SHA-256。恢复时验证清单、逐库恢复到指定 TXID、执行 SQLite `quick_check`、验证文件 hash，完成后才启动 Harness。有历史却找不到有效备份时直接失败，不静默建空库。同代次本地恢复按绑定标记复用；已停写的实例保持关闭，等待重试最终备份。

## 就绪与停机

第三方通过 envd 轮询：

```sh
/opt/agh/bin/backup-health --json
```

只返回三个字段：`backup_status`（`starting / healthy / syncing / degraded / failed`）、`last_sync_at`（ISO 时间或 null）、`last_error`（脱敏错误码或 null）。`healthy` 要求已发布可恢复清单，且本机云端鉴权就绪。管理进程心跳过期会显示降级。健康检查不发起模型推理。49983/envd 健康不代表 AGH 或备份已就绪；AGH 业务入口为 8443。

Litestream 正常按秒复制；管理进程每 5 秒核对完整数据库和普通文件集合，快照前后再次确认数据库位置，仅发布已确认复制的位置。新库运行中自动监控；最终同步会重新扫描及启动发现，并等待复制确认。这是异步复制，不承诺零丢失或固定一秒恢复。运行中的多个数据库快照不构成业务全局事务，干净停机提供最终一致的保存边界。大库、大文件或慢 COS 可能超过停机预算，必须走保留/暂停分支。

恢复实例先在业务写入方启动前，确认当前 epoch 的可恢复基线，再等待 Harness 鉴权就绪；避免待上报队列持续重试使首次就绪永远无法建立。后续仍执行完整集合快照；持续写入导致新切点未确认时会报告降级并保留上次 `last_sync_at`，不把旧基线当作最新写入均已同步。

平台停机顺序：禁用用户 Key，随后同步执行并等待：

```sh
/opt/agh/bin/prepare-stop
```

先关闭自有前端和 daemon 写入方，再完成数据库最终复制、CFS 文件快照和清单发布，全部完成才退出 `0`；失败或超时均非零。内部预算低于 30 秒（管理进程 28 秒、调用方 29 秒，shell 在 30 秒发 TERM，额外 1 秒强制退出余量），envd 超时设为 35 秒。只有成功后才立即 KillSandbox；失败时 PauseSandbox 保留并告警，唤醒后刷新 STS，重试同一命令，不重新开放业务。不增加 operation_id 或公共管理 HTTP API，内部控制仅使用权限 `0600` 的 Unix socket。

已停写实例不能仅通过 ResumeSandbox 和刷新 STS 重新标为 `running`。用户重开时，平台须先在 Key 禁用状态下唤醒旧实例、补齐最终同步，成功回收后再按新 epoch 恢复业务；失败继续暂停保留。此过程保留已付费周期，不能因补同步重建重复扣费。

SIGTERM 会尝试最终同步，但平台强杀时不能替代有退出码确认的停机协议。未收到成功退出码，就不能推断可以安全销毁。

## 验证与交付

使用仓库锁定的 Node v24.20.0 / pnpm 10.34.5 及统一入口。镜像专用 SDK 依赖单独安装：

```sh
node tools/toolchain/run.mjs exec npm ci --prefix tools/cloud-image/sync --ignore-scripts --workspaces=false --no-audit --no-fund
node tools/toolchain/run.mjs exec node --test tools/cloud-image/test/persistence.test.mjs tools/cloud-image/test/s3-store.e2e.test.mjs tools/cloud-image/test/runtime.e2e.test.mjs
AGH_TEST_LITESTREAM=/ABS/litestream node tools/toolchain/run.mjs exec node --test tools/cloud-image/test/litestream.e2e.test.mjs
node tools/toolchain/run.mjs exec node tools/cloud-image/test/build-authority-fixture.mjs /ABS/authority.mjs
AGH_TEST_LITESTREAM=/ABS/litestream AGH_TEST_AUTHORITY_MODULE=/ABS/authority.mjs node tools/toolchain/run.mjs exec node --test tools/cloud-image/test/authority-recovery.e2e.test.mjs
```

可选真实 COS 测试入口为 `test/cos-live.e2e.test.mjs`。只使用全新合成 state 的最小权限临时凭证，通过私有 `AGH_TEST_COS_STS_FILE` 提供 `state`、`first`（epoch 1）、`renewed`（epoch 1 新凭证）、`second`（epoch 2，可读历史 1）和 `secondRenewed`（epoch 2，恢复来源 0）。每份凭证均采用上文 STS JSON 字段。设置 `AGH_TEST_LITESTREAM` 后用统一入口运行此文件；默认跳过，远端测试对象保留，不在测试中删除既有数据。凭证文件、日志及测试账号信息不进入仓库。

测试使用与当前 OS/CPU 匹配的固定版本 Litestream。S3 本地协议测试、文件副本测试不能代替真实 COS/AGS 联调。上线前验收真实 STS 权限/续期/分块上传、CFS 映射、首次初始化、动态新库、附件/插件恢复、断网→暂停→重试、实例独占、WebSocket 入口、云端模型/上报，以及崩溃恢复的实际丢失窗口和耗时。AGS 标准 `read-only`、`workspace-write` 会话仍要求 bubblewrap 命名空间隔离实际可用，不能只验证二进制存在。

从锁定的 Node 基础镜像构建，不叠加旧 AGH 镜像。用 `docker save` 导出，可 gzip，不用 `docker export`。交付校验和、源码提交/快照、镜像配置 ID/digest、平台参数约定及实际验收结果。生产参数及私有测试记录放公开仓库外，验收完成前保留旧镜像。
