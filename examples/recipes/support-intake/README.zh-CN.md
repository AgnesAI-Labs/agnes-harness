# 客服初筛

[English](README.md) | 简体中文

[业务配方](../../../packages/package-manager/bundled-plugins/business-recipes/README.zh-CN.md)的独立可选场景。在插件目录安装并启用父插件，再从 Agent FDE 打开业务配方。审查本配方后才能启用。

输入：`ticket-104`；产出语言：`en` 或 `zh-CN`。参数是后台声明的有限选项，不插值任意提示词。产出样例：优先级 P2；转客服；起草回复供审查。

需要已配置的 `standard` 主模型路由；缺失配置由现有启动检查拒绝。仅在所选 bundle 中增加一个只读样例工具和 Skill。无网络、文件写入、客户数据或外部业务动作。模型文字是草稿，合成数据才是事实来源。明确启动后适用通常的模型费用和策略。升级后旧会话保留原后台快照。
