# Acme reference application

English | [简体中文](README.zh-CN.md)

One plugin delivers a tool, an agent and an application. `acme_status` returns synthetic status; `desk` is a Bundle with its own launch, using the host default Loop and Demo, with an explicit tool scope containing only `acme_status`. `application` supplies Acme identity, the Ava assistant name, PNG mark/favicon, an overview page and navigation defaults. Only public contracts are imported; Core and customer systems are untouched.

## Deployer adoption

Build this source revision using [installation](../../docs/guide/install.md). Run from the checkout root with a fresh isolated home and no real account or key.

```sh
export AGH_SOURCE="$PWD"
export AGH_HOME="$(mktemp -d /tmp/agh-acme.XXXXXX)"
export AGH_HOME="$(cd "$AGH_HOME" && pwd -P)"
export AGNES_PROFILE=local-dev
node agnes.mjs plugins add "$AGH_SOURCE/examples/acme"
node agnes.mjs daemon stop
node agnes.mjs serve --port 4198
```

`plugins add` may already start a daemon in this home, so run the `daemon stop` above before selecting the Web port. Alternatively, start `serve --port 4198` in another terminal before installing, so installation reuses the selected origin. Every terminal must use the same home and profile. If an existing daemon has a different origin, startup intentionally refuses with `local daemon Web origin does not match the selected origin`. Run `node agnes.mjs daemon stop`, then retry `serve` with the selected port; no home deletion or authentication changes are needed.

Confirm after reviewing the install preview’s capabilities, source and integrity. An unattended synthetic trial may add `--yes` to `plugins add`. Installation/trust/enable only adds a candidate; it does not change the selected application. Open the printed URL, select Acme under **Settings → Application**, inspect the consent preview, then adopt: identity/assets, home, hidden Automation entry, visible/default agent, role replacements, source/signature/integrity, dependency permission diff, scope and recovery. No takeover role is declared, so host navigation and conversation presentation remain available. The additional page leaves the sidebar intact.

The SDK can preview and adopt through the same CAS contract. Keep the same environment in a second terminal and run from the checkout root. The first command only previews. `@agnes/sdk` uses source-preview dependencies; no npm publication is promised. After review, the second command explicitly adopts with the latest preview digest and current revision; expect `active`.

```sh
pnpm --filter @agnes/cli exec node --import tsx --input-type=module --eval "$(cat examples/acme/adopt.mjs)"
ACME_ADOPT=1 pnpm --filter @agnes/cli exec node --import tsx --input-type=module --eval "$(cat examples/acme/adopt.mjs)"
node agnes.mjs --new --agent '@acme/operations#desk' -p 'call acme_status'
```

Expect the tool result `{"service":"acme-demo","status":"healthy","synthetic":true}`. Launch prompt drafts remain editable and are submitted normally, never auto-sent. In daily use select Acme operations on the Agents page; the default Loop needs no extra installation.

## Recovery and upgrades

Open **`/?admin`**. The separate host recovery bootstrap runs before application JS, CSS, takeover roles and navigation, using AGH identity. The URL grants no administration authority. Clearing also works offline:

```sh
node agnes.mjs app clear --profile local-dev --json
node agnes.mjs daemon stop
```

Clearing only removes presentation selection; it does not revoke trust, release pins or change execution configuration. Online clearing uses CAS; offline uses the same lock/revision. Disable, untrust, removal or changed upgrade digests retain an unresolved selection and fall back to AGH, never another application. Updates require renewed trust review and preview/adoption. Explicit URL > user preference > application default > host default. Selection preserves old-session execution identity. Profile pages follow current activation; session renderers follow their pinned generation.

The PNG assets are original project geometry under Apache-2.0. Trusted JavaScript is not sandboxed; hidden navigation is not access control. See the [application contract](../../docs/extend/applications.md). Real customer/model, browser and cross-platform acceptance are not established by this example.
