# 钉钉适配器核验记录

| 日期 | SDK 版本 | ① 群 @ | ② 卡片回调 | ③ 断网重连 | 附件下载（A5） | 备注 |
|---|---|---|---|---|---|---|
| 待跑 | 2.1.6-beta.1 | 待验证 | 待验证 | 待验证 | 待验证 | 需要钉钉测试企业与 AppKey；本地假网关已通过 |

运行入口：

```sh
pnpm --filter @agnes/channels exec tsx scripts/dingtalk-verify.ts --config <yaml> --chat <群 openConversationId>
```

核验通过后，须把 `gateway-real.ts` 的 A1–A6 逐条标为“已核验 + 日期”，并按实测结果更新
`channel.json` 的能力与连接模式。本文件当前只记录可重复的核验入口，不把假网关结果冒充真实企业证据。
