# Security policy / 安全报告

Agnes Harness is a pre-alpha source preview. Security fixes are evaluated against the current development branch; there is no published stable support or patch schedule yet.

## Report privately / 私密报告

Once the repository is public **and GitHub private vulnerability reporting is enabled**, use **Security → Advisories → Report a vulnerability** on the [Agnes Harness repository](https://github.com/AgnesAI-Labs/agnes-harness/security/advisories/new). Include the affected revision, impact, minimal reproduction, and any relevant error codes. Remove credentials, customer data, and private traces from the report. Do not disclose an unpatched vulnerability in a public Issue, Discussion, or pull request.

仓库公开且已启用 GitHub 私密漏洞报告后，请在仓库的 **Security → Advisories → Report a vulnerability** 提交。写明受影响版本、影响、最小复现及相关错误码，并移除凭据、客户数据和私有日志。未修复的漏洞不要通过公开 Issue、Discussion 或 PR 报告。

GitHub makes this reporting feature available to **public** repositories. After the repository becomes public, the repository administrator must enable it under **Settings → Advanced Security → Private vulnerability reporting** and verify that the report button is visible before announcing this as an active reporting channel. Until that verification is complete, this document does not claim an active external reporting channel. See [GitHub's configuration guide](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).

GitHub 的该功能面向**公开仓库**。仓库公开后，管理员需要在 **Settings → Advanced Security → Private vulnerability reporting** 启用，并在宣布该入口可用前确认报告按钮可见。在完成这一步之前，本页不宣称已有对外生效的报告入口。

## Scope / 范围

The [security guide](docs/guide/security.md) explains the current trust and execution boundaries. Ordinary third-party Cordis plugins are trusted in-process code; installing one is not equivalent to running untrusted code in a sandbox. Please report a bypass of a documented boundary privately, with the smallest reproducible case you can share.

[安全与信任指南](docs/guide/security.md)说明当前的信任与执行边界。普通第三方 Cordis 插件属于受信进程内代码，安装插件不等于把恶意代码放进隔离沙箱。发现已声明边界被绕过时，请按上述方式私密报告，并提供可分享的最小复现。
