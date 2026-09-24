# Development and feedback

[中文指南](docs/develop/contributing.md) · [English overview](README.md)

Real use cases help shape AGH. Try an example, build a plugin, and tell us what worked or where you got stuck. Star the project to save it and use Watch to follow updates.

## Share feedback

Use Issues → New issue to choose a [bug report](.github/ISSUE_TEMPLATE/bug_report.yml) or [use-case suggestion](.github/ISSUE_TEMPLATE/feature_request.yml). Chinese and English are welcome; feedback does not require a code contribution.

For a bug report, include the source revision, OS and architecture, Node/pnpm versions, minimal steps, expected and actual behavior, and a short redacted log excerpt. Do not attach credentials, a complete AGH home, customer data or private traces. Report vulnerabilities through the [security policy](SECURITY.md).

## Current development policy

**Code and documentation pull requests are currently limited to invited internal developers with write access. External pull requests are not accepted at this stage.** You may use, study and adapt the project under its applicable licenses.

## For invited developers

1. Follow the [installation guide](docs/guide/install.md) and [local demo](docs/guide/demo.md).
2. Read [AGENTS.md](AGENTS.md) and locate the owning module in the [source map](docs/develop/source-map.md).
3. Explain the problem and scope. Agree on public API, architecture and security changes before implementing them.
4. Keep the diff focused, update affected documentation, and run the checks in [the development guide](docs/develop/contributing.md).
5. Describe actual verification results and remaining limitations in the pull request. Follow the repository's review and required-check rules.

Project-authored code uses [Apache License 2.0](LICENSE). Third-party components and some examples retain separate terms; see [NOTICE](NOTICE) and [licensing details](docs/maintainers/provenance.md). Contributions intentionally submitted for inclusion use the Apache-2.0 contribution terms unless explicitly stated otherwise.
