# 插座消费合同（哪些插座、什么时刻、经哪道门）

<!-- Handwritten contract reference; not managed by gen-docs. -->

本文回答一个访问控制问题：**只用公开 `@agnes/extension-api` 的扩展，在运行时能亲手调哪些插座。**
它不回答「插座由谁实现」——那是 `profile.seams.<name>` 选包的事，见 spec §1.3。

## 两组插座

11 个插座全部已落地、全部在被内核调用；除 `platform` 外，其余 10 个全部可经 `profile.seams.*` 换实现。
`platform` 是唯一例外：它固定是 `@agnes/host` 自带后端，profile 里 `seams.platform` 点名任何其它包都会被
**静默忽略**——既不报错也不生效（`host/src/assemble/seams.ts`，见下表第 9 行）。「开放 / 不开放」是另一个
维度，与「换不换实现」无关：**第三方扩展代码在运行时有没有函数能调到它。**

| | 换实现（包提供 + profile 点名，装配期，§1.3） | 运行时被扩展代码调（§4 放行表） |
|---|---|---|
| **7 个**：sandbox、artifacts、principals、ledger、checkpoint、harness、Provider | 能 | **能**（经内核转手的窄口，不是整个交出去；7 个里仍有 5 个成员不给，见 §4） |
| **1 个**：platform | **不能**——固定是 `@agnes/host` 自带后端，profile 点名其它包被静默忽略 | **能**（`PlatformView` / `PlatformFacts`，只读，不设门） |
| **3 个**：approval、verifier、repair | 能（今天的实现：`base/extensions/approval-policy/src/seam.ts`、`base/extensions/loop-hygiene/src/{verifier,repair}.ts`） | **不能**——任何上下文上都没有对应的函数 |

为什么是这三个：它们是内核自己的**决定**（何时问用户、何时验输出、失败怎么处置），让扩展代码能触发它们
等于让扩展替内核做决定；其余 8 个是**能力**，能力可以借给扩展用，决定权不行。

三个角色：**包**提供实现（`PackageModule.seams`，`host/src/assemble/packages.ts:100`）→ **profile** 点名选用
（`assemble.ts:171/223`；未点名 = 什么都不发生）→ **扩展**运行时按本表消费。改源码是 fork，与这三者无关。

## 放行表

**先说清一件事：11 个插座全部已落地、全部在被内核调用；除 `platform`（固定 `@agnes/host` 自带后端，
不经 `profile.seams.*` 换实现）外，其余 10 个全部可经 `profile.seams.*` 换实现——本表不动这件事。
本表只回答一个访问控制问题：「第三方扩展能不能亲手调它」。表里写「不给」的插座（approval / verifier / repair），
内核照样每天在调，扩展照样享受它们的效果（工具被问授权、输出被验、失败被修），只是扩展自己没有调用它们的函数。**

「今天」列写的是本文动手前的事实；「本文后」是合同。「不给」的成员，**任何**上下文上都不出现同名键。

| # | 插座 · 成员 | 今天 | 本文后 | 为什么 |
|---|---|---|---|---|
| 1 | **sandbox** `exec` / `confine` / `fsPolicy` / `enforcement` | `ctx.exec`（tool + service）、`ctx.sandbox.confine`（仅 tool，Q1） | 不动前两者；**新增** `ctx.sandbox.enforcement()`（仅 tool）；`fsPolicy` 不给 | 工具该知道自己有没有被关住（对应 `preset.sandbox.onUnavailable`）。路径规则与 digest 是 host 内部物，扩展经 `ctx.fs.*` 已被它管着。`confine` 是远程沙箱唯一可能改口径的成员，本文按 Q1 原样保留 |
| 2 | **artifacts** `put / get / submitJob / poll / cancel` | tool 全部，门 `caps.artifacts`；service 只有 `get` | 不动 | 已是完整通道；service 侧的 put/submitJob 由 S5 jobs 适配器另管，不在本文 |
| 3 | **principals** `resolve` / `authorize` | `ctx.authorize`（tool + service） | 不动；`resolve` 不给 | 凭据 → actor 是 host 的事；能 resolve 就能造 actor |
| 4 | **ledger** `record` / `projected` | 读：`ctx.projections.readOwn`（tool + hook，门 `caps.projections`）；写：`agnes.events.append` 落 `x/<extId>/<name>`（门 `caps.events`），内核替扩展记 | 不动；`record` 直写不给 | 账本每一笔必须经内核的 effect sandwich；扩展只能「请内核记」 |
| 5 | **checkpoint** `snapshot / rewind / list` | 隐式：每次 `ctx.fs.write` 内核先 `checkpointSnapshot`（`tool-context.ts:133`） | 不动；三个成员都不给 | `rewind` 等于从工具里绕过步进记账改用户的树；`list` 没人要；`snapshot` 已由内核在唯一需要的地方做了 |
| 6 | **approval** `ask` / `resume` | 无；工具声明 `meta.requiresApproval`，内核去问 | 不给 | 让扩展自己措辞弹窗 = 骗授权的面；内核问，账本才记得住「谁为什么问」。用户 2026-09-15 拍板维持不给 |
| 7 | **verifier** `verify` | 无 | 不给 | 按 tier 烧模型预算；内核只在 tool / step / turn / task 边界叫它；扩展经钩子看结论。用户 2026-09-15 拍板维持不给 |
| 8 | **repair** `decide` | 无 | 不给 | 内核对失败工具的处置决策，扩展没有可用语义。用户 2026-09-15 拍板维持不给 |
| 9 | **platform** `shell / fs / terminal / capability` | 无 | **开放，只读，不设门，四个时刻都给**：tool / service 拿 `PlatformView`（事实 + `capability(id)` 探测）；hook / factory 拿 `PlatformFacts`（纯数据） | 纯事实、可 JSON 化，所以 isolated 扩展也拿得到快照。这是本文唯一真正的「新通道」。换实现方面 `platform` 是 11 个插座里唯一不能经 `profile.seams.*` 换的：`host/src/assemble/seams.ts` 把它排除在九个「包供、profile 点名」的插座之外，固定用 `@agnes/host` 自己的后端；profile 里 `seams.platform` 点名任何其它包都被静默忽略，不报错、不生效 |
| 10 | **harness** `propose` | 无；Q2：`tools.invoke('harness_propose')` | 不动 | 已拍板 |
| 11 | **Provider** `infer / models / count` | 无；门是 `ctx.subagent.fork / spawn`（`caps.subagent`） | 不动；`infer / models / count` 直连都不给 | 直连绕过账本、契约戳、计费；`ModelRecord.headers` 里有密钥，`models()` 也不能裸给 |

## 关闭项与不给的成员

**数一下：** 11 个里 8 个第三方有路可走（1、2、3、4、5、9、10、11），3 个完全不给（6、7、8）。
另有 5 个成员即使插座开着也不给：`principals.resolve`、`ledger.record`、`checkpoint.*`、
`sandbox.fsPolicy`、`provider.*` 直连。

**内置专属路径（G5）：** `packages/base/src/ecosystem.ts` 的闭包注入是 base 9 个内置包拿完整 seam 对象
的批准路径，只对 base 开放，不是待补的临时方案；第三方按本表。

## 时刻承诺

- 工厂 / 钩子的 `platform` 是装配时刻（`Kernel` 构造 / host 装配）算好的冻结快照，`terminal.width` 不承诺实时。
- 工具 / 服务的 `platform` 在每次构造上下文时取；`capability(id)` 每次都真的探测。
- `sandbox.enforcement()` 是沙箱插座当下的答案，不缓存。

## 版本

1.1.0 起。要用 `platform` / `sandbox.enforcement` 的扩展在 manifest `apiRange` 里声明 `>=1.1.0`。
