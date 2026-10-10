import { createElement } from 'react'

/** Shared fixed form contract for React mounting and legacy DOM consumers. */
export const CUSTOM_MODEL_FIELDS = `<fieldset id="config-custom-fields" class="config-section config-custom-section" hidden><legend>自定义模型</legend>
<p class="field-hint form-field-wide">填写网关提供的协议和模型 ID，再验证实际推理。模型目录仅供选择，不代表模型能力。</p>
<label class="form-field form-field-wide">请求协议<select id="config-custom-api"><option value="openai-completions">Chat Completions</option><option value="openai-responses">Responses</option></select></label>
<div class="config-custom-model-card form-field-wide">
<label class="form-field">默认模型 ID<input id="config-custom-model" maxlength="256" autocomplete="off" placeholder="例如：服务提供的模型 ID" aria-describedby="config-custom-catalogue-state" /></label>
<label class="form-field">从模型目录选择<select id="config-custom-discovered" aria-describedby="config-custom-catalogue-state"></select></label>
<div class="config-actions"><button id="config-custom-discover" type="button" class="secondary-button">获取模型列表</button><button id="config-custom-import" type="button" class="secondary-button" disabled>导入全部模型 ID</button></div>
<p id="config-custom-catalogue-state" class="field-hint" role="status" aria-live="polite">可手工填写模型 ID，或从目录选择。导入的模型共用本页容量与能力声明；只验证默认模型。</p>
</div>
<div class="config-capability-card form-field-wide">
<label class="config-capability-option"><input id="config-custom-system" type="checkbox" aria-describedby="config-custom-system-hint" /><span><strong>声明网关保留中途 system 消息的顺序</strong><small>启用 JevLoop 所需的兼容能力</small></span></label>
<p id="config-custom-system-hint" class="field-hint">仅在网关契约或实现依据支持时勾选。测试只验证请求被接受，不证明消息未被合并或重排；JevLoop 还需要中途 system 请求测试通过。</p>
</div>
<details class="config-custom-advanced form-field-wide"><summary>容量与其他能力</summary>
<div class="config-custom-advanced-grid">
<label class="form-field">模型上下文容量（Token）<input id="config-custom-context" type="number" min="1024" max="10000000" value="32768" /></label>
<label class="form-field">最大输出（Token）<input id="config-custom-output" type="number" min="1" max="1000000" value="4096" /></label>
<label class="form-field form-field-wide">输出上限字段<select id="config-custom-max-field"><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></label>
<label class="config-capability-option"><input id="config-custom-tools" type="checkbox" checked /> 原生 OpenAI 工具调用</label>
<label class="config-capability-option"><input id="config-custom-image" type="checkbox" /> 支持图片输入</label>
<label class="config-capability-option"><input id="config-custom-reasoning" type="checkbox" /> 推理模型</label>
<p class="field-hint form-field-wide">容量和其他能力由你声明，本次测试不验证工具或图片输入。未配置价格显示为未知。</p>
</div></details>
<div id="config-custom-verification" class="config-custom-verification form-field-wide" role="status" aria-live="polite" data-state="untested">
<div class="config-verification-heading"><strong>端点验证</strong><span id="config-custom-verification-state">尚未测试</span></div>
<p id="config-custom-verification-target" class="field-hint"></p>
<ul id="config-custom-verification-checks" class="config-verification-checks"></ul>
<p id="config-custom-verification-hint" class="field-hint">测试会调用默认模型，可能产生费用。保存时会再次验证当前配置。</p>
</div></fieldset>`

export function SettingsCustomModelFields() {
  return createElement('div', {
    // biome-ignore lint/security/noDangerouslySetInnerHtml: fixed shared form template, never caller data.
    dangerouslySetInnerHTML: { __html: CUSTOM_MODEL_FIELDS },
  })
}

export const JEV_SETTINGS_MARKUP = `<section id="jev-settings-pane" class="settings-content" data-agnes-region="settings-pane" hidden>
<header class="config-heading"><div><p class="eyebrow">决策服务</p><h2>决策后端配置</h2><p>配置当前 home/profile 的 Jev 或本地 Laya 服务。保存后需手动重启后台，运行中的任务不受影响。</p></div></header>
<div class="config-workspace"><fieldset class="config-card config-section"><legend>连接信息</legend>
<label class="form-field">决策后端<select id="jev-backend"><option value="jev">Jev</option><option value="laya">本地 Laya（实验性）</option></select></label>
<label class="form-field">传输类型<select id="jev-transport"><option value="native">原生 HTTP（System One）</option><option value="cloudflare">Cloudflare</option></select></label>
<label id="jev-account-field" class="form-field" hidden>Cloudflare Account ID<input id="jev-account" maxlength="32" autocomplete="off" /></label>
<label class="form-field">Endpoint<input id="jev-endpoint" maxlength="2048" type="url" autocomplete="off" /></label>
<label class="form-field">模型<input id="jev-model" maxlength="256" value="jev-latest" autocomplete="off" /></label>
<label class="form-field">认证<select id="jev-auth"><option value="bearer">Bearer</option><option value="none">无认证（仅显式原生配置）</option></select></label>
<label id="jev-key-field" class="form-field">API Key / Token<input id="jev-key" type="password" autocomplete="new-password" placeholder="留空保留已保存密钥；修改目标时须输入新密钥" /></label>
<label class="jev-enabled-option form-field-wide"><input id="jev-enabled" type="checkbox" checked /> 启用 JevLoop</label>
<label class="form-field">每次决策请求 credits（可选）<input id="jev-decision-credits" type="number" min="0" step="any" placeholder="未知" /></label>
<label class="form-field">每次语言请求 credits（可选）<input id="jev-language-credits" type="number" min="0" step="any" placeholder="未知" /></label>
<p class="field-hint form-field-wide">密钥由后台私有存储，页面不回填。本地 Laya 需另行启动服务，仅支持原生 HTTP；当前是有限上下文的实验性接入，不自动下载权重。Cloudflare 按 Jev 官方策略估算 token 费用，不代表实际账单。Laya 缺少用量或价格时保留未知。每请求 credits 是可选的预算估算，留空不会阻止常规任务执行。</p>
</fieldset><p id="jev-source" role="status"></p></div>
<footer class="config-actions jev-settings-actions"><div class="jev-settings-feedback"><p id="jev-state" role="status" aria-live="polite"></p><p id="jev-error" role="alert"></p></div><div class="jev-settings-buttons"><button id="jev-test" class="secondary-button" type="button">测试连接</button><button id="jev-save" class="primary-button" type="button">保存决策配置</button><button id="jev-refresh" class="secondary-button" type="button">重新读取</button></div></footer>
</section>`

export function SettingsJevPane() {
  return createElement('div', {
    'data-agnes-region-owner': 'builtin',
    'data-agnes-region-unit': 'settings-jev',
    // biome-ignore lint/security/noDangerouslySetInnerHtml: fixed shared form template, never caller data.
    dangerouslySetInnerHTML: { __html: JEV_SETTINGS_MARKUP },
  })
}
