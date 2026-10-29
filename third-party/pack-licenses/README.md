# Distribution license supplements

`sources.json` records the locked package version and the source of each supplement.
The notice collector uses a supplement only when both package name and version match.
No network fetch happens during packing or local-registry smoke.

Some npm payloads omit a standalone LICENSE. Supplements preserve upstream license
texts, README grants, or source headers, with immutable upstream URLs where available.
`@npmcli/agent`, `clean-git-ref`, and `use-composed-ref` expose only license metadata in
these inspected sources. Their supplements preserve the original metadata and README;
these are **not substitutes for complete license attribution**. The release owner must
resolve or explicitly approve those notices before public distribution. Do not invent
copyright holders or treat an SPDX string as a legal review.

For upstream license snapshots, review the source against the locked version before
public distribution. This directory adds no dependency and does not alter upstream code.
