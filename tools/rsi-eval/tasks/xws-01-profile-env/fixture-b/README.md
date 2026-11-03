# ledger-jobs

Nightly bookkeeping jobs. Each job is a shell script `jobs/<name>.sh`; `bin/acme run <name>` runs it and keeps what it prints in `out/<name>.txt`.
