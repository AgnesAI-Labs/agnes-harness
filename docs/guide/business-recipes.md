# Business recipes

English | [简体中文](business-recipes.zh-CN.md)

Find a business workflow by its task, inputs, permissions and sample result. The optional `@agnes/business-recipes` plugin uses the existing built-in catalogue and Agent FDE launch path. It is disabled by default and adds no tools to ordinary sessions.

## Enable discovery

In **Plugins**, find **Business recipes**, inspect its permissions, install, trust and enable it. Open **Business recipes** from Agent FDE or the sidebar. Merely opening the page reads metadata; it does not install a recipe, upload data or start a model run.

The initial selection uses only packaged synthetic data: support intake (`ticket-104`), invoice review (`invoice-207`) and meeting brief (`meeting-309`). Every recipe is a separate optional package. Review its version, integrity and declared capabilities before confirming installation, trust and enablement. Uninstalled, untrusted, disabled and ready states have different labels; an old server with unknown trust requires review.

## Review and run

Choose the listed fixture and output language using the shared keyboard-accessible controls. These finite parameters select a backend-declared launch, never an interpolated path or arbitrary prompt. Select **Review launch** and inspect the exact bundle, preset and JSON input before selecting **Start this reviewed run**.

Configure the `standard` primary model route in **Models & accounts** first. The three bundles inherit that route; there is no hidden model fallback. Each selects one read-only fixture tool and a Skill. They produce conversation drafts: support routing/reply, invoice discrepancy (120 − 100 = 20), or an action brief with the explicit owner/date. They do not send messages, write files, create tasks or connect to real business systems. Explicitly launched model requests use normal authorization and may incur model charges.

Open the returned session to inspect the draft and execution evidence. Recipe previews never enumerate other sessions. Launch authority comes from the authenticated host, reviewed parent/child activation and selected bundle, not from the page or fixture text.

## Failure and lifecycle

- Missing model, preset or bundle: fix Models & accounts or Plugins, refresh, and review a fresh launch.
- Changed package, trust or dependency activation: refresh and review the current bytes. Disabled dependencies immediately invalidate launch authority.
- Lost reply: check the operation receipt before retrying; the same ticket/operation ID creates one session and durable input through the existing launch journal. Unknown dispatch outcomes do not replay automatically.
- Disable or uninstall: the home entry and FDE link disappear and registrations are released. Already admitted sessions continue under their own lifecycle. Backend snapshots remain pinned for historical sessions; upgrades affect new sessions.

No additional registry, connector credentials, network upload, global session reader or G0 extension is required. See the [package README](../../packages/package-manager/bundled-plugins/business-recipes/README.md) and [plugin lifecycle](packages.md).
