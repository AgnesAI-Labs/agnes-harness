# Agnes Harness (AGH)

## A Recoverable, Evidence-First Agent Runtime

This repository publishes the as-built technical architecture report for **Agnes Harness (AGH)**, an implemented, model-independent agent runtime designed around controlled effects, precise recovery, and verifiable execution.

## Report

- [Read the full report](REPORT.md)
- [Download the PDF](agnes-harness-tech-report.pdf)

## Core Architecture

- A **Trusted Core** that owns command ordering, policy, approvals, budgets, external effects, and committed task state.
- An append-only **event ledger** as the source of truth for model context, operator views, recovery, and evaluation.
- An **Effect Sandwich** for durable intent, policy and approval, bounded execution, and durable outcomes.
- Typed replay semantics, versioned host and event contracts, and a policy-controlled extension model.

## Evidence Boundary

This is an as-built implementation report. It documents completed system architecture and verification methods; it does not introduce unsupplied throughput, latency, cost, or task-success benchmarks.

## Publication

Prepared by Agnes Harness Engineering. The PDF is the canonical visual version of the report; `REPORT.md` is a complete text transcription for direct reading and search.
