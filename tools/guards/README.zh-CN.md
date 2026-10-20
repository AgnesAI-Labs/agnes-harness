# 仓库门禁

[English](README.md) | 简体中文

在仓库根目录通过[固定工具链](../../docs/maintainers/verification.zh-CN.md)运行
`pnpm test:guards`，执行完整 guards 及其正反夹具。

## 三种不同的源码行数合同

- `scope-line-count.test.ts` **只报告** `scope-line-count.json` 中各 scope 的有效行差值；增长不失败。
  快照无需每次改动更新；重叠 scope 不能相加。原 ratchet 路径及消费方已统一更名。
- `file-size.test.ts` 是**硬门**：packages/tools 的生产源及内置展示插件的手写源以 800 有效行为限。
  `file-size-allowlist.json` 精确冻结已存在的大文件上限；新增超额文件、超过上限或残留无效条目均失败。
- `function-size.test.ts` 是**硬门**：递归解析 `core/src/execution/turn`、`host/src/runtime/generation`、
  `daemon/src/supervisor`。覆盖 declaration、expression、arrow、method、get/set、嵌套和回调，以及多行签名。
  以固定 TypeScript AST 定位节点，复用 `countLines`，包含签名及嵌套文本，上限为 **210 有效行**。
  初始覆盖 99 个文件、1,997 个节点；20 个既有超额节点精确冻结在 `function-size-allowlist.json`。
  身份为路径加完整 enclosing AST path，不用行号；命名变量锚定词法块，重复匿名回调保留结构序号。
  新超额节点、上限增长和失效条目均失败。报告还输出 statement 数、AST 结构指纹及相对基线的结构变化。
  嵌套函数与外层函数的 LOC 重叠，不能相加；把多个 statement 压到一行会降低 LOC，此门不是复杂度评分。

原 assemble/CU 门继续保留：`assemble()` 为 20 物理行，`assemble.ts` 为 330 有效行，
assemble/CU stage 文件为 480 有效行，这些文件中按列零格式识别的函数为 210 物理行；不自动放宽旧口径。

file/function allowance 与**受保护分支 merge-base** 比较，新条目和增大上限均失败，即使同时修改源码与 JSON。
CI 从 PR 事件读取 base SHA，main push 使用前一 tip，并获取完整 Git 历史；本地使用
`origin/feat/agh-plugin-core`（该分支移除后使用 `origin/main`）。缺历史即拒绝。首次引入的新清单以已复审的精确 seed 摘要冻结；
一旦保护分支已有清单，以上游 Git 版本为上限。

`pnpm guards:remeasure` 刷新行数报告，并只收紧 file/function 上限；拒绝新增超额、既有增长及预先放大的 JSON。
`--check` 不写入，也拒绝失效条目。`--allow-increase` 只能在**独立维护者预算变更**中使用，
该变更只能包含预算 JSON 和维护者文档；它仅准备新预算，不能绕过 CI 的基线比较。
放大预算还需单独、显式复审门禁政策；禁止夹带在功能变更中。

## Host 官方业务语义 fence

`host-business.test.ts` 强制：**Host 不包含官方业务身份及官方实现依赖；已审查 legacy 例外只减**。
递归扫描七个 Host 包生产源、模板和生产依赖；从官方 manifest、随发行提供的 bundled payload 提取 row ID/export。
尚未声明的兼容默认值单独列明。基础设施与纯合同 leaf 单独分类，observability 实现整包仍受限制。

扫描静态 import/export/import-type、字面动态 import、字符串、模板片段、正则、已知默认常量
（含导入别名、namespace 引用），以及简单字符串别名的比较分支。
TS/MTS/CTS/TSX 与手写 JS/MJS/CJS/JSX 使用同一策略；生产根下 `fixtures/` 不免检。
解析错误、空扫描和未分类源码后缀均失败；测试文件与生成/构建输出排除。
静态规则不能完整证明计算字符串语义；review 禁止拼接逃逸，capability/pin 仍需准入测试。
此门不改变运行时授权。

`host-business-allowlist.json` 按**精确路径 + enclosing symbol + literal/import + 语法角色 + 次数上限 + 移除步骤**
冻结逐项复审的业务例外，无目录或通配符豁免。新增 ID/import/比较、次数增长、失效条目或相对保护基线放大清单均失败；
部分删除也必须收紧次数上限。`remeasure` 不生成 Host 例外。A1–A5 只指明后续迁移 owner，本次不执行迁移。

内部 Host Symbol 和事件 wire namespace 保留为合同。固定控制面、历史 origin/receipt、凭据格式和本地强制实施的精确用法
在 `host-business-contracts.json` 单列原因，不列待删除步骤；不能由此豁免整个文件或实现包，位置、角色和次数也不能增加。
社区插件的 typed kind/capability 声明通过；原 builtin extension row 完整性检查保持不变。

## 样式层

`css-layers.json` 指定唯一层级顺序及由 loader 提供层级的精确次数例外：skin CSS 属于 `skin`、
client module CSS 属于 `app`、生成 Tailwind 属于 `ui`；截图归一化只在显式测试夹具中例外。
生产 CSS 必须有 layer，未分层本地 import 必须引用已检查的样式表；新增 override 片段、失效条目或竞争的 root 顺序均失败。
移动样式时一起核对 loader 与 allowance；新增包装输入须说明原因并验证其分层边界。
