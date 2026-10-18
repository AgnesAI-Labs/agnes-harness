# 应用

[English](applications.md) | 简体中文

[插件元数据](plugin-metadata.zh-CN.md) · [UI 注册表](../develop/ui-extension-registries.zh-CN.md)

应用提供产品身份、展示默认值和智能体目录。安装、信任或启用应用包只让它成为候选；管理员在
**设置 → 应用**中显式预览、采纳。选择应用不会启用依赖，也不会改变执行 profile、组合哈希、已有会话、
pin、Actor、权限或模型 persona。

```json
{
  "application": {
    "id": "acme",
    "brand": {
      "name": { "en": "Acme", "zh-CN": "艾克米" },
      "title": { "en": "Acme Workbench" },
      "assistantName": { "en": "Ava" },
      "mark": "assets/mark.png"
    },
    "presentation": {
      "home": "acme/kit#overview",
      "skin": "acme",
      "navigation": { "entries": ["acme/kit#overview"], "hideBuiltin": ["agents", "automation"] },
      "roles": { "navigation": { "packageId": "acme/kit", "clientId": "navigation" } }
    },
    "defaultAgent": "acme/kit#work",
    "agents": ["acme/kit#work"]
  }
}
```

以上是 `package.json` 的 `agnes.application` 值；除 `id` 外均可省略。品牌文字复用
`{en, "zh-CN"?}` 本地化合同；`favicon` 与 `mark` 使用相同资产结构。inspect 从不可变包快照计算长度、MIME 和 SHA-256。
资产只能是包内普通文件，每个最多 128 KiB，长度、SHA-256、扩展名和 raster 签名须一致，支持 PNG、JPEG、
WebP、GIF、ICO；拒绝符号链接、路径穿越、URL 和 SVG。从已核验的安装包读取字节，在浏览器 CSP 下使用有界 blob URL。

主页和导航页面引用采用 `package#page`，由 profile client 静态声明 `homeEntries` 或 `examplePages`。
智能体必须是自身含 `launch` 的 Bundle；皮肤须由当前包声明。跨包目标需要声明依赖并在部署环境复验，
未知引用一律拒绝。

标准接管角色为 `navigation`、`conversation`、`composer`、`goal`、`interaction`、`deliverables`。
目标 client descriptor 必须有显式稳定 `client.id`、`lifetime: "profile"`，以及相应
`presentationRoles: ["navigation"]`。新增可选静态字段使 descriptor 从 16 字段增至 17，manifest 主干仍为 29。
inspect、不可变快照、信任哈希和浏览器 roster 全程保留声明。产品接管先按当前应用或用户显式选择筛选，
再执行 priority 选举；未选应用不能靠低 priority 抢占。普通页面、设置、卡片和 slots 保留原有作用域及语义。

同意预览绑定来源和签名状态、包/版本/完整性、品牌及资产、隐藏入口、主页/皮肤、智能体、角色代码来源、
依赖权限及差异、作用范围和恢复方法。采纳和清除沿用 admin principal、method allowlist 与配置 CAS revision；
预览变化或 revision 过期都会拒绝。品牌变更属于正常包升级，需要重新信任及显式采纳；旧会话保留原执行 pin。
受信 JavaScript 与工作台同环境运行，并非沙箱。

无选择时显示宿主 AGH。安装 B 不会替换已选 A。A 被停用、撤信、移除、更新或资产/引用不可用时，保留选择并标记
**unresolved** 及原因，展示安全回落 AGH，绝不自动选 B。优先级依次是 URL 显式覆盖、用户偏好、应用默认、宿主默认；
清除应用只移除应用默认，保留用户偏好。

**`/?admin`** 是独立宿主恢复 bootstrap，在导入应用 JavaScript、CSS、角色和导航之前选择宿主品牌与皮肤。
URL 不授予权限，写操作仍经认证 BFF 与 admin 校验。**`agh app clear [--profile NAME] [--json]`**
在通用 boot 前分派，不加载插件，只清除展示选择。daemon 运行时走在线 CAS；否则使用同一配置锁和 revision 原子写入。

页面引用在浏览器保留并复验包身份；客户端加载失败、尚未就绪或同名冲突不会把其他包的普通页面当作已采纳主页。应用变化会同步撤销其 CSS/token，迟到的 CSS 响应不能重新上色；URL、用户偏好的优先级保持不变。

品牌资产还必须通过真实像素解码：最多 1,048,576 总像素、32 帧，编解码超时两秒；ICO 需使用 PNG 帧，旧 DIB 编码拒绝。浏览器加载或解码失败时回退宿主。配置保存已同意的完整预览及摘要，因此同 ref 升级、卸载旧包后仍比较旧/新传递依赖闭包；旧同意快照无法验证时明确显示“未知”，不声称没有变化。

[Acme 参考应用](../../examples/acme/README.zh-CN.md)提供工具、默认 Loop 智能体、品牌栅格资产、追加页面和可执行的 SDK 预览／采纳命令。

## 启动 Acme 的前置条件

在同一 home 和 profile 下，先启动选定 origin 的 Web 服务，再安装应用；或在安装后、启动 Web 前执行 `node agnes.mjs daemon stop`。`plugins add` 本身可能启动 daemon。若其 origin 不匹配，`serve --port 4198` 会拒绝并提示 `local daemon Web origin does not match the selected origin`。停止该 home 的 daemon 后重试同一 `serve` 命令即可；完整命令见 [Acme 部署流程](../../examples/acme/README.zh-CN.md#部署者采用流程)。
