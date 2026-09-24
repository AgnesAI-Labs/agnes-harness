# 运行时构建目录中断后的检查

[English](build-recovery.md) | 简体中文

[文档导航](../README.zh-CN.md) · [安装](install.zh-CN.md)

适用 Windows、macOS 和 Linux 上 CLI 的 `build:local`，以及 CLI 和 Daemon 的 `build:runtime` 输出。不是应用在线升级或用户会话数据迁移。

`build:local` 默认输出是 `packages/cli/dist/local`，对应 `local.build-lock`、`local.tmp-*` 和锁内的 `previous`。以下以 `build:runtime` 的目录名举例，两种构建使用相同事务。

正常情况下，构建结束只留下`dist/agnes-runtime`。构建期间，同级`agnes-runtime.build-lock`阻止另一个构建；随机`agnes-runtime.tmp-*`存放尚未提交的新包，锁目录中的`previous`暂存旧包。

遇到锁错误，不要根据目录存在时间或名字直接删除它。先确认该输出对应的构建进程已退出，并保留输出、锁和暂存目录，避免两个构建同时操作。

- 输出存在且完整：先核验总manifest中的文件摘要及配套Node版本，再判断是准备阶段中断还是提交成功后清理失败。后一种情况下`previous`可能只剩部分内容，不能直接覆盖当前新包。
- 输出不存在、`previous`存在：可能在旧包移走后中断，或回滚失败。先验证备份完整，再在同一磁盘恢复到原输出位置；有权限/占用错误时保留现场，不先删除备份。
- 输出与备份都缺失：不能靠清理锁恢复旧包。确认构建进程已退出后保留日志，修复权限或磁盘问题，再从可信源码重新构建。

`build:local` 没有总 manifest，不能套用 `build:runtime` 的 manifest 核验：需要核对 CLI、daemon、worker、web 及本平台 native 文件，使用对应版本 Node 检查启动。如果不能确认备份完整，保留现场，从可信源码构建到新的绝对路径（`build:local --output-dir <新目录>`），不要拼接新旧目录。

只有确认当前输出恢复且无构建进程使用它后，才处理本次遗留的锁和暂存目录；先将证据移到同磁盘独立保留目录，再重试构建。macOS/Linux 也不要依据 PID 或目录年龄直接删除锁。工具目前不会自动抢锁或自动恢复强退现场；不保证跨文件系统原子提交或断电恢复。
