# AGH Plugin Helper

A default, removable AGH plugin for creating tool, Skill and pure CSS skin plugins in conversation. Read the authoring guide, create source files and inspect the package, then explicitly approve installation. Package identity, requested capabilities and content integrity are bound to that approval. After the turn ends, query status and test the actual contribution.

The initial authoring flow accepts self-contained text ESM packages without dependencies or lifecycle scripts. It does not publish packages, replace installed packages, or bypass AGH file/permission policy. Inspection checks the package contract; it is not a security audit of JavaScript. The installation prompt explains that local code will run.

`plugin_helper_install` requires `commit`, `status` or `cancel` and the exact `proposalId` returned by create. Prepared is a preview; installing/submitted are pending activation, and cancelling is pending cancellation. End the turn after submission and query status later. Ready confirms that the exact backend package is running; test its actual contribution separately. Review changed, interrupted or failed state in Settings, and report denial/cancellation without automatic retry or bypass.

For a skin, read `plugin_helper_guide` with `kind: skin`. Its complete template uses `agnes.plugins` and a row-bound `clientDescriptors` file. Select the installed skin in Settings → General → Appearance, verify light/dark modes and disable recovery. Backend status does not verify browser appearance.
