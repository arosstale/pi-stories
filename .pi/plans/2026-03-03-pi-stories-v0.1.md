# pi-stories v0.1 — Blueprint Engine for AI Agent Orchestration

**Date:** 2026-03-03
**Status:** Active
**Repository:** github.com/arosstale/pi-stories

## Overview

pi-stories is a multi-agent orchestration CLI that turns a one-line prompt into a merged PR using any combination of models, sandboxes, and quality gates. It's built on two pillars that Overstory lacks: **Blueprint Engine [D]/[N] interleaving** (deterministic gates between every non-deterministic agent step) and **cost routing** (auto-select cheapest model per phase).

## Why Not Just Use Overstory?

Overstory has great infrastructure (SQLite mail, merge queue, dashboard) but no architectural opinion about HOW agents should work together. It spawns agents and hopes for the best. pi-stories enforces the [D]/[N] pattern that Stripe and Mario proved at scale.

## Architecture

### The Pipeline (Core Innovation)

```
[D] Pre-compute context.json (git diff, LSP, test results)
    ↓
[N] Scout (Haiku) — read context, find relevant code
    ↓
[D] Validate scout output (files exist, schema valid)
    ↓
[N] Plan (Sonnet) — design the implementation
    ↓
[D] Validate plan (schema, file paths resolve)
    ↓
[N] Build (Sonnet) — implement the plan
    ↓
[D] Lint + Format + Typecheck
    ↓
[N] Review (Opus) — review the diff
    ↓
[D] Test suite
    ↓
[D] Commit + PR
    ↓
[D] Cost report
```

Every [D] step is deterministic — it either passes or fails with a clear error. Every [N] step is an AI agent call with measured cost. If a [D] gate fails, the pipeline retries the previous [N] step (up to 3 times) before failing.

### Cost Routing

```
Tier 1 (Scout, Quick Fix):   Haiku      ~$0.001/call
Tier 2 (Build, Plan):        Sonnet     ~$0.01/call
Tier 3 (Review, Architect):  Opus       ~$0.10/call
```

The `--budget` flag sets a ceiling. If budget is tight, review downgrades from Opus to Sonnet. If budget is generous, scout upgrades from Haiku to Sonnet for better context gathering.

### Runtime Registry

```typescript
interface AgentRuntime {
  name: string;           // 'pi' | 'claude' | 'codex' | 'gemini-cli' | ...
  spawn(task: Task): Promise<RunHandle>;
  status(handle: RunHandle): Promise<AgentStatus>;
  kill(handle: RunHandle): Promise<void>;
  output(handle: RunHandle): Promise<string>;
  cost(handle: RunHandle): Promise<CostReport>;
}
```

18 runtimes via Bun.spawn. Each runtime adapter normalizes the interface:
- Local: pi, claude, gemini-cli, codex, aider, goose, amp, cursor, antigravity, gemini
- Remote: gh agent-task, jules, e2b
- Platform: openclaw
- Tools: docker, gh, beepctl, pi-messenger

### State on Disk

```
.pi-stories/
  config.yaml              # Project config (runtimes, budget, gates)
  runs/
    {run-id}/
      context.json         # [D] Pre-computed context
      scout.json           # [N] Scout output
      plan.json            # [N] Plan output
      build.log            # [N] Build output
      review.json          # [N] Review output
      cost.json            # Accumulated cost per phase
      events.jsonl         # Event log (what ov trace queries)
      status.json          # Current pipeline state
  runtimes.yaml            # Runtime registry + pricing
  costs.db                 # SQLite cost history
```

Everything is JSON on disk (resumable, inspectable, `jq`-queryable) except cost history which is SQLite for aggregation queries.

## v0.1 Commands (Phase 1 — Ship This First)

```
pi-stories init              # Create .pi-stories/ with defaults
pi-stories run <task>        # Execute Blueprint Engine pipeline
  --budget <amount>          # Cost ceiling (default: $5.00)
  --runtime <name>           # Force specific runtime (default: auto)
  --dry-run                  # Show pipeline plan without executing
  --skip-review              # Skip review phase
  --retry <n>                # Max retries per [N] step (default: 3)
pi-stories status            # Show active/recent runs
pi-stories costs             # Token/cost breakdown per run, per phase
pi-stories doctor            # Health check (runtimes available, git clean, etc.)
```

## v0.2 Commands (Phase 2 — Observability)

```
pi-stories trace <run-id>    # Event timeline for a run
pi-stories replay <run-id>   # Replay agent actions chronologically
pi-stories logs              # Query NDJSON event logs
pi-stories dashboard         # Live TUI monitoring
```

## v0.3 Commands (Phase 3 — Multi-Agent)

```
pi-stories sling <task>      # Spawn a single agent (like ov sling)
pi-stories mail send/check   # Inter-agent messaging
pi-stories merge             # Merge agent branches
pi-stories nudge <agent>     # Poke stalled agent
pi-stories stop <agent>      # Kill agent
pi-stories group             # Batch task management
```

## v0.4 Commands (Phase 4 — Full Parity + Beyond)

```
pi-stories watch             # Watchdog daemon
pi-stories monitor           # Tier 2 AI monitor
pi-stories clean             # Nuclear cleanup
pi-stories upgrade           # Self-update
pi-stories config            # View/edit config
pi-stories export            # Export run as shareable report
```

## Tech Stack

- **Runtime:** Bun (TypeScript, bun:sqlite, Bun.spawn)
- **CLI:** Commander.js
- **Linting:** Biome
- **Database:** bun:sqlite for costs.db, JSON files for run state
- **Testing:** bun test

## Key Decisions

1. **JSON state on disk, not SQLite for runs** — jq queryable, git diffable, human readable. SQLite only for aggregate cost queries.
2. **Bun.spawn for agent dispatch** — lowest level, works with all 18 CLIs, no dependency on pi's subagent system (which only works inside pi sessions).
3. **Blueprint Engine is the default** — `pi-stories run` always uses [D]/[N]. Raw agent spawn is `pi-stories sling` (v0.3).
4. **Cost tracking is mandatory** — every [N] step reports tokens used. No silent spending.
5. **Retry with escalation** — if Haiku scout fails, retry with Sonnet. If Sonnet build fails, retry with Opus. Cost goes up but success rate goes up more.

## File Structure (v0.1)

```
pi-stories/
  src/
    index.ts                 # CLI entry (Commander.js)
    types.ts                 # All shared types
    config.ts                # Config loader
    errors.ts                # Custom error types
    commands/
      init.ts                # pi-stories init
      run.ts                 # pi-stories run (Blueprint Engine)
      status.ts              # pi-stories status
      costs.ts               # pi-stories costs
      doctor.ts              # pi-stories doctor
    pipeline/
      engine.ts              # Blueprint Engine orchestrator
      steps.ts               # [D] and [N] step definitions
      context.ts             # [D] Pre-compute context.json
      gates.ts               # [D] Lint, test, typecheck gates
      retry.ts               # Retry + escalation logic
    runtimes/
      types.ts               # AgentRuntime interface
      registry.ts            # Runtime discovery + factory
      pi.ts                  # Pi runtime adapter
      claude.ts              # Claude Code adapter
      codex.ts               # Codex adapter
      gemini.ts              # Gemini CLI adapter
      generic.ts             # Generic CLI adapter (fallback)
    costs/
      tracker.ts             # Cost accumulator
      pricing.ts             # Model pricing table
      store.ts               # SQLite cost persistence
    logging/
      events.ts              # JSONL event logger
      reporter.ts            # Console reporter
  agents/
    scout.md                 # Scout agent instructions
    planner.md               # Planner agent instructions
    builder.md               # Builder agent instructions
    reviewer.md              # Reviewer agent instructions
  templates/
    config.yaml              # Default config template
  package.json
  tsconfig.json
  biome.json
  README.md
  LICENSE                    # MIT
```

## Success Criteria

- [ ] `pi-stories init` creates .pi-stories/ with valid config
- [ ] `pi-stories run "fix the login bug"` executes full [D]/[N] pipeline
- [ ] Cost report shows per-phase token usage
- [ ] `pi-stories doctor` validates all runtimes
- [ ] Pipeline resumes from last successful [D] gate on failure
- [ ] At least pi + claude + codex runtimes working
- [ ] Published to github.com/arosstale/pi-stories with README
