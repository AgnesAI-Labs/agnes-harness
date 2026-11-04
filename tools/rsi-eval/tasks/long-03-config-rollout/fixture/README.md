# Service configs

Each service's settings live in `services/<service>.conf`, one `key = value` per line. The
environments are dev, canary, shadow and prod. `bin/rollout` deploys a config (`bin/rollout help`):
`bin/rollout lint <service>` checks the file, `bin/rollout apply <service> <env>` deploys it to an
environment, and `bin/rollout status <service>` shows what every environment runs.
