# Computer Use compatibility fixtures

`0.9/catalog.selected.json` is a JSON-format-only copy of
`tests/fixtures/cua_driver_0_9_tools_list.json` from NousResearch/hermes-agent commit
`fb56a7e06dde62e9f645ff744c82cb47b60c469e`. Its original source SHA-256 and the SHA-256 of the
checked-in normalized bytes are both locked in `compatibility-matrix.json`.

The copied fixture is covered by the upstream MIT license, Copyright (c) 2025 Nous Research. Agnes'
repository-level Computer Use NOTICE retains the complete license and source mapping.

`0.10/permission-mode.behavior.json` is a reviewed, source-derived table of the four direct
permission-mode assertions in `tests/tools/test_computer_use_cua_0_10_permissions.py` at the same
fixed Hermes commit. Its upstream source and derived-byte SHA-256 values are locked in the matrix.
It is marked `source-behavior`: it is neither a cua-driver manifest, MCP/parser fixture, nor a driver
capture, and it cannot satisfy a production admission or platform evidence requirement.

Rows marked `missing` are hard blockers, not synthetic data. Unit-test objects used to exercise rejection
paths are not evidence and must never be promoted to `verified`. A future real driver capture must record
the fixed cua release, commit, capture platform, time, sanitization, and checked-in byte digest.

`0.28.1/{manifest,catalog,result,doctor}.json` are normalized captures from the locked Windows x86_64
archive on Windows 11 build 26200. Local paths, usernames, window handles/counts, process state, and the
driver's update notice were removed. The catalog retains all 57 observed tool names, capability arrays,
and input schemas. `result.json` uses the content-free `check_permissions` call. SOM remains missing because
no successful, public, content-safe element-index capture has been produced.
