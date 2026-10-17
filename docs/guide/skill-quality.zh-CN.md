# 审查技能质量证据

[English](skill-quality.md) | 简体中文

在设置 → 插件 → 目录中安装可选的“技能质量”，审核权限并启用。插件默认关闭，提供两个延迟发现工具及独立会话工作台面板，不替代候选批准/拒绝。

1. 通过已有技能/插件创作流程创建候选，或调用 `skill_quality_candidate`，传 `action: "create"` 与完整 `files` 列表。草稿留在私有候选区域。
2. 用 `skill_quality_candidate({action: "read", candidateId})` 读取当前收据，记录候选哈希和安装基线；来源会话来自 Host 溯源。
3. 导出 P01 评测报告或准备离线报告，按[包内夹具](../../packages/package-manager/bundled-plugins/skill-quality/src/fixtures/eval.json)人工转换，填写候选哈希、基线、技能修订、原报告摘要、环境哈希、运行环境/模型/执行器/模式/预算说明、样例和实际执行数。将 JSON 作为 `evidenceJson` 传给 `skill_quality_import`。这始终是**未经验证的人工导入**，即使原报告声称“runner”或“approved”。自评使用 `kind: "self-assessment"`；Host 作者测试和人审属于独立事实，不能导入。
4. 若获准查看当前安装清单，将当前完整性哈希作为 `currentInstalledHash`；尚未安装时传 `null`，未知则省略。观察值一致不证明实时有效；插件不会隐式读取全局清单。
5. 在此会话工作台打开“技能质量”并刷新，查看成功/失败样例、执行数和环境哈希。候选编辑、基线变化或不同的安装观察值都会让旧证据过期。重新读取候选会清除安装观察值；缺少信息显示未知。变化后重新导入相应报告和当前观察值。
6. 用 `action: "test"`、`candidateId`、`expectedHash` 调用 `skill_quality_candidate`。Host 控制精确哈希的执行确认及隔离作者测试结果。再用 `action: "submit"` 提交测试通过的哈希。可选 `skill-quality.review` Loop 通过正常审批依次执行，并在提交前单独确认；配置见[包 README](../../packages/package-manager/bundled-plugins/skill-quality/README.zh-CN.md)。
7. 在设置 → 插件 → 候选审核中发布或拒绝。拒绝不会安装或启用候选；升级候选失败不会改变已安装代码和旧会话固定版本。新会话使用已发布的新版后端代码；技能是实时资源，旧会话也可能读到更新。

导入限制为 48 KiB、24 个案例，每个记录会话在 56 KiB 总状态预算内保留八个候选。零执行或全跳过报告被拒绝，不执行报告正文、不获取产物 URL、不调用模型。面板只查询显式获准读取的选中会话。服务缺失或后台响应不兼容时显示不可用；旧会话缺少候选工具时请新建会话执行创作操作；检查安装或权限后刷新。卸载会释放前端注册。

质量只作参考，任何评分都不能授予人审批准、信任或启用。发布质量门禁需要另行评审通用证据签发/校验合同；自动评测与实时安装状态是后续集成。本示例验证模拟离线证据，不代表真实模型质量或平台验收。
