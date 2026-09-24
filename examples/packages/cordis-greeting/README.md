# Cordis greeting plugin

This example shows the complete author-facing shape of an Agnes in-process plugin:

- `package.json` declares the named `greeting` export and its default configuration.
- `index.ts` defines a normal Cordis object plugin with a schema and one provided service.
- `greeting.test.ts` proves that enable, configuration update, invalid configuration, and disable
  all behave as expected.

Install the package, confirm that you trust it, and enable it from the plugin page. The default
configuration publishes `demoGreeting` with the value `Hello from an Agnes plugin`. Changing the
`message` configuration updates that value without restarting the host.
