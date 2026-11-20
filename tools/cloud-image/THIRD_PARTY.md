# 云端镜像依赖说明

以下依赖仅供镜像使用，与 `third-party/runtime-dependencies.json` 中的工作区依赖分开维护。源码不包含凭证或实际生产配置。

| 组件 | 固定版本 | 来源 | 许可证 | 用途 |
| --- | --- | --- | --- | --- |
| Litestream | 0.5.18 | https://github.com/benbjohnson/litestream/tree/v0.5.18 | Apache-2.0 | SQLite WAL 复制、递归目录发现和确认同步/恢复；不直接复制活动 SQLite/WAL 文件。 |
| `@aws-sdk/client-s3` | 3.1150.0 | https://github.com/aws/aws-sdk-js-v3/tree/main/clients/client-s3 | Apache-2.0 | S3 兼容 COS 清单传输、签名、重试与取消，复用官方 SDK。 |
| Node.js 基础镜像 | 24.20.0-bookworm-slim | https://github.com/nodejs/docker-node | MIT / 随包声明 | 运行时与 Debian 基础系统；保留内置声明。 |
| envd | v0.5.14 | `ccr.ccs.tencentyun.com/ags-image/envd:v0.5.14` | 服务商分发运行时 | AGS 管理入口，运维须核对其分发条款及声明。 |

`sync/package-lock.json` 锁定 SDK 传递依赖、下载地址、完整性哈希和声明许可证。`npm ci --omit=dev --ignore-scripts` 在 `/opt/agh/sync/node_modules` 保留各包许可证，不得单独剥离。SDK 包完整性：

```text
sha512-tv7KzK7PY7GqBwA6nzAVAsazIY/tAagDjlqvmCwlIYpH2SMfUuD6pJklg++LGcMaNy5p0VMvz+F+/es1BpoyRw==
```

Litestream 官方发行包从 `https://github.com/benbjohnson/litestream/releases/download/v0.5.18/` 下载，在解压前校验：

| 文件 | SHA-256 |
| --- | --- |
| `litestream-0.5.18-linux-x86_64.tar.gz` | `d3687b9fd0f2e9426bbd3da828429ff3f1dfc5c9b74d54fdf028e4ee510e7dea` |
| `litestream-0.5.18-linux-arm64.tar.gz` | `922a09e6a7ac67f2095571894dc6382e94e1dd4cdd9674883ddf1a8e74ab982d` |
| 上游 `v0.5.18/LICENSE` | `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` |

上游许可证安装到 `/opt/agh/licenses/Litestream-LICENSE`；本说明随镜像交付。独立构建的 Harness 与云端插件保留各自 LICENSE 和 NOTICE，Debian 工具保留 `/usr/share/doc` 声明。本说明用于记录来源与用途，不代替漏洞扫描或许可证审核。
