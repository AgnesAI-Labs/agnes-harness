# 插件用途文案提案

[English](CONTENT.md) | 简体中文

**状态：待审核文案，尚未写入产品清单。**

[页面与合同设计](DESIGN.zh-CN.md)

为了保持英文与中文 summary 的对应关系，完整逐项内容采用同一张双语表，以下入口直接定位该表：

- [37 个官方 extension manifest](CONTENT.md#official-extension-manifests-37)：每项都有类别、英文/中文显示名和准确 summary。
- [56 个 example/FDE package.json 文件](CONTENT.md#example-packages-56-files-including-version-and-failure-fixtures)：包括 40 个包身份、多版本与故意损坏的测试包。
- [其他官方包与插件行](CONTENT.md#additional-official-package--row-coverage)：补充默认 Loop、文件记忆、遥测、base 与四个官方辅助包，并要求实施时继续覆盖实际注册的官方行。

这张表只是作者文案的编辑提案，不能作为运行时逐 ID 查询表。实施时英文存入 metadata 的基础字段，中文存入 locales.zh-CN；说明段落补充作用范围、先决条件与选用方式，不增加没有证据的保证。

样例目录相对 examples/；同用途的 v1/v2 共享用途短句，broken 文件明确失败测试目的。FDE 文案明确模拟/样例和人工批准或审阅；demos 是可运行的演示脚本包，不是可安装业务插件。JSONL 持久化和 Docker 沙箱是 provider 库，安装本身不代表已被选用。
