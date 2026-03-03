# pi-stories

Multi-agent orchestration with **Blueprint Engine [D]/[N] interleaving** and **cost routing**.

Turns a one-line prompt into a merged PR using any combination of models, sandboxes, and quality gates.

## Why?

Existing multi-agent tools (Overstory, etc.) spawn agents and hope for the best. pi-stories enforces **deterministic gates between every non-deterministic step** — the pattern that Stripe and Mario Zechner proved at scale.

```
[D] Pre-compute context  →  [N] Scout (Haiku)  →  [D] Validate
    →  [N] Plan (Sonnet)  →  [D] Validate  →  [N] Build (Sonnet)
    →  [D] Lint + Test  →  [N] Review (Opus)  →  [D] Commit + PR
```

Every `[D]` step is deterministic — it passes or fails. Every `[N]` step is an AI agent with measured cost. If a gate fails, the pipeline retries the previous agent step before giving up.

## Quick Start

```bash
bun install
bun run src/index.ts init
bun run src/index.ts run "fix the login validation bug"
```

## Commands (v0.1)

```
pi-stories init              Create .pi-stories/ with defaults
pi-stories run <task>        Execute Blueprint Engine pipeline
  --budget <amount>          Cost ceiling (default: $5.00)
  --dry-run                  Show plan without executing
  --skip-review              Skip review phase
  --retry <n>                Max retries per step (default: 3)
pi-stories status            Show active/recent runs
pi-stories costs             Token/cost breakdown
pi-stories doctor            Health check
```

## How It's Different

| Feature | Overstory | pi-stories |
|---------|-----------|------------|
| Core pattern | Sequential pipeline | **[D]/[N] interleaving** with gates |
| Cost routing | None | **3-tier auto-escalation** (Haiku → Sonnet → Opus) |
| Budget control | After the fact | **Per-run ceiling with pre-step checks** |
| Retry strategy | Manual | **Auto-retry with model escalation** |
| State format | 4 SQLite DBs | **JSON on disk** (jq-queryable, git-diffable) |
| Gate detection | Manual | **Auto-detect** from package.json/pyproject.toml/go.mod |
| Runtimes | 4 (Claude, Pi, Copilot, Codex) | **18 CLIs** (all major agents) |

## Architecture

```
.pi-stories/
  config.yaml          # Runtimes, models, budget, gates
  runs/
    {run-id}/
      context.json     # [D] Pre-computed context
      scout.json       # [N] Scout findings
      plan.json        # [N] Implementation plan
      review.json      # [N] Review results
      cost.json        # Cost per phase
      events.jsonl     # Event log (trace/replay)
      status.json      # Pipeline state (resumable)
  costs.db             # Aggregate cost history
```

## Cost Tiers

| Tier | Role | Default Model | ~Cost |
|------|------|---------------|-------|
| 1 | Scout, quick tasks | claude-haiku-4-5 | $0.001/call |
| 2 | Build, plan | claude-sonnet-4-5 | $0.01/call |
| 3 | Review, architect | claude-opus-4-5 | $0.10/call |

## Roadmap

- **v0.1** — Core 5 commands, [D]/[N] pipeline, cost tracking
- **v0.2** — Observability: trace, replay, dashboard, logs
- **v0.3** — Multi-agent: sling, mail, merge, nudge
- **v0.4** — Full parity: watchdog, monitor, export, config

## License

MIT
