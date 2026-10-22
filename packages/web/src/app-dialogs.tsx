import { resourceAdminShellLocaleCatalog } from '@agnes/resource-control-web/locale-shell'
import { indexShellLocaleCatalog } from '@agnes/web-foundation/locales/index-shell'
import {
  Button,
  createCatalogTranslator,
  Disclosure,
  IconTile,
  renderRegion,
  SettingsCheckbox,
  SettingsInput,
  SettingsSelect,
  SettingsTextArea,
  useDocumentLanguage,
} from '@agnes/web-ui'

const shellCatalog = {
  en: { ...indexShellLocaleCatalog.en, ...resourceAdminShellLocaleCatalog.en },
  'zh-CN': { ...indexShellLocaleCatalog['zh-CN'], ...resourceAdminShellLocaleCatalog['zh-CN'] },
}
const useDialogText = () =>
  createCatalogTranslator(shellCatalog, useDocumentLanguage() === 'zh-CN' ? 'zh-CN' : 'en')

const NPM_LABEL = 'npm'
const X_API_KEY_LABEL = 'x-api-key'
const X_API_TOKEN_LABEL = 'x-api-token'

function SourceDialogScaffold() {
  const t = useDialogText()
  return (
    <form id="source-form" className="plugin-dialog-form">
      <div className="dialog-heading">
        <div>
          <p className="eyebrow">{t('index-shell.sourceKicker')}</p>
          <h2 id="source-dialog-title">{t('index-shell.sourceHeading')}</h2>
        </div>
      </div>
      <p className="dialog-intro">{t('index-shell.sourceIntro')}</p>
      <label className="form-field" htmlFor="source-type">
        <span>{t('index-shell.sourceTypeLabel')}</span>
        <SettingsSelect id="source-type">
          <option value="npm">{NPM_LABEL}</option>
          <option value="file">{t('index-shell.sourceTypeFile')}</option>
          <option value="workspace">{t('index-shell.sourceTypeWorkspace')}</option>
          <option value="git">{t('index-shell.sourceTypeGit')}</option>
        </SettingsSelect>
      </label>
      <label className="form-field" htmlFor="source-ref">
        <span>{t('index-shell.sourceRefLabel')}</span>
        <SettingsInput
          id="source-ref"
          required
          autoComplete="off"
          spellCheck={false}
          placeholder={t('index-shell.sourceRefPlaceholder')}
        />
      </label>
      <p className="field-hint">{t('index-shell.sourceRefHint')}</p>
      <p id="source-error" className="plugin-form-error" role="alert"></p>
      <div className="dialog-actions">
        <Button id="source-cancel" htmlType="button" appearance="secondary">
          {t('index-shell.cancel')}
        </Button>
        <Button htmlType="submit" appearance="primary">
          {t('index-shell.sourceSubmit')}
        </Button>
      </div>
    </form>
  )
}

function PluginConfirmScaffold() {
  const t = useDialogText()
  return (
    <div className="plugin-dialog-form">
      <div className="dialog-heading">
        <div>
          <p className="eyebrow">{t('index-shell.confirmKicker')}</p>
          <h2 id="plugin-confirm-title">{t('index-shell.confirmHeading')}</h2>
        </div>
      </div>
      <p id="plugin-confirm-description" className="dialog-intro"></p>
      <div id="plugin-confirm-preview" className="confirm-facts" hidden></div>
      <div className="dialog-actions">
        <Button id="plugin-confirm-cancel" htmlType="button" appearance="secondary">
          {t('index-shell.cancel')}
        </Button>
        <Button id="plugin-confirm-action" htmlType="button" appearance="primary">
          {t('index-shell.confirmSubmit')}
        </Button>
      </div>
    </div>
  )
}

function McpDialogScaffold() {
  const t = useDialogText()
  return (
    <form id="mcp-form" className="plugin-dialog-form">
      <div className="dialog-heading">
        <h2 id="mcp-dialog-title">{t('index-shell.mcpHeading')}</h2>
      </div>
      <p className="dialog-intro">{t('shell.dialog.description')}</p>
      <p id="mcp-step" className="dialog-step" role="status"></p>
      <section className="agnes-settings-stack" id="mcp-methods" aria-label={t('wizard.choose')}>
        {(
          [
            ['local', 'terminal'],
            ['remote', 'globe'],
            ['agent', 'bot'],
          ] as const
        ).map(([method, icon]) => (
          <Button
            key={method}
            id={`mcp-method-${method}`}
            className="mcp-method-card"
            htmlType="button"
            {...(method === 'agent' ? { href: '/?new=1' } : {})}
            appearance="secondary"
            aria-labelledby={`mcp-method-${method}-title`}
            aria-describedby={`mcp-method-${method}-description`}
          >
            <IconTile name={icon} />
            <span className="mcp-method-copy">
              <span id={`mcp-method-${method}-title`} className="mcp-method-title">
                {t(`wizard.${method}`)}
              </span>
              <span id={`mcp-method-${method}-description`} className="mcp-method-description">
                {t(`wizard.${method}Help`)}
              </span>
            </span>
          </Button>
        ))}
      </section>
      <section className="agnes-settings-stack" id="mcp-connection-fields" hidden>
        <label id="mcp-url-row" className="form-field" hidden htmlFor="mcp-url">
          <span>{t('index-shell.mcpUrlLabel')}</span>
          <SettingsInput id="mcp-url" type="url" autoComplete="off" placeholder="https://example.com/mcp" />
        </label>
        <label id="mcp-command-row" className="form-field" htmlFor="mcp-command">
          <span>{t('wizard.command')}</span>
          <SettingsInput
            id="mcp-command"
            autoComplete="off"
            placeholder={t('index-shell.mcpCommandPlaceholder')}
          />
        </label>
        <p id="mcp-named" className="form-hint" hidden></p>
        <div id="mcp-oauth-row" className="agnes-settings-stack" hidden>
          <SettingsCheckbox id="mcp-oauth" label={t('wizard.oauth')} />
          <p className="form-hint">{t('wizard.oauthHelp')}</p>
          <label id="mcp-oauth-client-row" className="form-field" hidden htmlFor="mcp-oauth-client">
            <span>{t('wizard.oauthClient')}</span>
            <SettingsInput id="mcp-oauth-client" maxLength={256} autoComplete="off" />
          </label>
        </div>
        <label className="form-field" htmlFor="mcp-credential">
          <span>{t('wizard.credential')}</span>
          <SettingsSelect id="mcp-credential">
            <option value="">{t('shell.form.secret-none')}</option>
          </SettingsSelect>
        </label>
        <p id="mcp-credential-status" role="status"></p>
        <a
          href="https://github.com/AgnesAI-Labs/agnes-harness/blob/feat/agh-plugin-core/docs/guide/mcp.md"
          target="_blank"
          rel="noopener"
        >
          {t('wizard.credentialHelp')}
        </a>
        <Disclosure className="agnes-settings-details" id="mcp-advanced" summary={t('wizard.advanced')}>
          <div className="agnes-settings-stack">
            <label className="form-field" htmlFor="mcp-token-env">
              <span>{t('wizard.env')}</span>
              <SettingsInput id="mcp-token-env" defaultValue="TOKEN" autoComplete="off" />
            </label>
            <label className="form-field" htmlFor="mcp-name">
              <span>{t('index-shell.mcpNameLabel')}</span>
              <SettingsInput
                id="mcp-name"
                maxLength={128}
                autoComplete="off"
                placeholder={t('shell.form.name-placeholder')}
              />
            </label>
            <label className="form-field" htmlFor="mcp-id">
              <span>{t('index-shell.mcpIdLabel')}</span>
              <SettingsInput
                id="mcp-id"
                maxLength={128}
                autoComplete="off"
                placeholder={t('index-shell.mcpIdPlaceholder')}
              />
            </label>
            <label className="form-field" htmlFor="mcp-transport">
              <span>{t('index-shell.mcpTransportLabel')}</span>
              <SettingsSelect id="mcp-transport">
                <option value="stdio">{t('index-shell.mcpTransportStdio')}</option>
                <option value="http">{t('index-shell.mcpTransportHttp')}</option>
                <option value="sse">{t('index-shell.mcpTransportSse')}</option>
              </SettingsSelect>
            </label>
            <label id="mcp-workspace-row" className="form-field" htmlFor="mcp-workspace">
              <span>{t('sandbox.workspace')}</span>
              <SettingsInput id="mcp-workspace" autoComplete="off" />
            </label>
            <label id="mcp-sandbox-row" className="form-field" htmlFor="mcp-sandbox">
              <span>{t('sandbox.title')}</span>
              <SettingsSelect id="mcp-sandbox">
                <option value="strict">{t('sandbox.strict')}</option>
                <option value="workspace-write">{t('sandbox.workspace-write')}</option>
                <option value="network">{t('sandbox.network')}</option>
                <option value="off-with-warning">{t('sandbox.off-with-warning')}</option>
              </SettingsSelect>
            </label>
            <label id="mcp-executable-row" className="form-field" htmlFor="mcp-executable">
              <span>{t('index-shell.mcpExecutableLabel')}</span>
              <SettingsInput
                id="mcp-executable"
                autoComplete="off"
                placeholder={t('index-shell.mcpExecutablePlaceholder')}
              />
            </label>
            <label id="mcp-args-row" className="form-field" htmlFor="mcp-args">
              <span>{t('index-shell.mcpArgsLabel')}</span>
              <SettingsTextArea id="mcp-args" rows={3} spellCheck={false}></SettingsTextArea>
            </label>
            <label className="form-field" htmlFor="mcp-secret-kind">
              <span>{t('index-shell.mcpSecretKindLabel')}</span>
              <SettingsSelect id="mcp-secret-kind">
                <option value="none">{t('index-shell.mcpSecretNone')}</option>
                <option value="stdio-env">{t('index-shell.mcpSecretStdioEnv')}</option>
                <option value="http-bearer">{t('index-shell.mcpSecretHttpBearer')}</option>
                <option value="http-header">{t('index-shell.mcpSecretHttpHeader')}</option>
                <option value="oauth">{t('wizard.oauthKind')}</option>
              </SettingsSelect>
            </label>
            <label id="mcp-header-row" className="form-field" hidden htmlFor="mcp-header-name">
              <span>{t('index-shell.mcpHeaderLabel')}</span>
              <SettingsSelect id="mcp-header-name">
                <option value="x-api-key">{X_API_KEY_LABEL}</option>
                <option value="x-api-token">{X_API_TOKEN_LABEL}</option>
              </SettingsSelect>
            </label>
            <label id="mcp-secret-row" className="form-field" htmlFor="mcp-secret">
              <span>{t('index-shell.mcpSecretMappingLabel')}</span>
              <SettingsTextArea
                id="mcp-secret"
                rows={3}
                spellCheck={false}
                placeholder="secret://namespace/name or TOKEN=secret://namespace/name"
              ></SettingsTextArea>
            </label>
            <label className="form-field" htmlFor="mcp-tools">
              <span>{t('index-shell.mcpToolsLabel')}</span>
              <SettingsTextArea id="mcp-tools" rows={3} spellCheck={false}></SettingsTextArea>
            </label>
          </div>
        </Disclosure>
      </section>
      <p id="mcp-error" className="plugin-form-error" role="alert"></p>
      <div className="dialog-actions">
        <Button id="mcp-back" className="dialog-action-aside" htmlType="button" appearance="ghost">
          {t('wizard.back')}
        </Button>
        <Button id="mcp-cancel" htmlType="button" appearance="secondary">
          {t('index-shell.cancel')}
        </Button>
        <Button htmlType="submit" appearance="primary">
          {t('shell.form.submit')}
        </Button>
      </div>
    </form>
  )
}

function AdminConfirmScaffold() {
  const t = useDialogText()
  return (
    <div className="plugin-dialog-form">
      <div className="dialog-heading">
        <div>
          <p className="eyebrow">{t('index-shell.confirmKicker')}</p>
          <h2 id="admin-confirm-title">{t('index-shell.confirmHeading')}</h2>
        </div>
      </div>
      <p id="admin-confirm-description" className="dialog-intro"></p>
      <div id="admin-confirm-preview" className="confirm-facts" hidden></div>
      <div className="dialog-actions">
        <Button id="admin-confirm-cancel" htmlType="button" appearance="secondary">
          {t('index-shell.cancel')}
        </Button>
        <Button id="admin-confirm-action" htmlType="button" appearance="primary">
          {t('index-shell.confirmSubmit')}
        </Button>
      </div>
    </div>
  )
}

/** Initial form contracts; controllers replace these region snapshots when they own a dialog. */
export function renderAppDialogs() {
  const sourceDialogScaffoldHost = document.getElementById('source-dialog')
  if (sourceDialogScaffoldHost) renderRegion(sourceDialogScaffoldHost, <SourceDialogScaffold />)
  const pluginConfirmScaffoldHost = document.getElementById('plugin-confirm')
  if (pluginConfirmScaffoldHost) renderRegion(pluginConfirmScaffoldHost, <PluginConfirmScaffold />)
  const mcpDialogScaffoldHost = document.getElementById('mcp-dialog')
  if (mcpDialogScaffoldHost) renderRegion(mcpDialogScaffoldHost, <McpDialogScaffold />)
  const adminConfirmScaffoldHost = document.getElementById('admin-confirm')
  if (adminConfirmScaffoldHost) renderRegion(adminConfirmScaffoldHost, <AdminConfirmScaffold />)
}
