# Read-only tool policy

Install this directory as a local package and enable its `policy:read-only` plugin row. Select it in a preset:

```yaml
approval:
  policy: read-only
```

Read-only calls are allowed; writes and destructive tools are denied, including in full-access sessions. Core still enforces principal authorization, sandboxing and effect recovery. Disabling the selected plugin fails closed with a missing-provider error. The default policy remains selected when `approval.policy` is omitted.
