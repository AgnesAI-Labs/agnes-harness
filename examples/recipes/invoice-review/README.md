# Invoice review

English | [简体中文](README.zh-CN.md)

Optional independent recipe for [Business recipes](../../../packages/package-manager/bundled-plugins/business-recipes/README.md). Install and enable the parent from Plugins, then open Business recipes from Agent FDE. Review this recipe before enabling it.

Input: `invoice-207`; output language: `en` or `zh-CN`. These are finite, backend-declared launch parameters, not arbitrary prompt interpolation. Output example: Invoice total 120; ledger total 100; discrepancy 20.

Requires a configured `standard` primary model route; missing configuration fails through the existing launch check. The recipe adds one read-only fixture tool and a Skill only to its selected bundle. No network, file writes, customer data or external business actions. Model text is a draft; the synthetic fixture remains the source of truth. Normal model charges and policy apply when you explicitly launch it. Existing sessions retain their backend snapshot after upgrade.
