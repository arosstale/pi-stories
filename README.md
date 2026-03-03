# pi-stories

Multi-agent orchestration with **Blueprint Engine [D]/[N] interleaving** and **cost routing**.

Turns a one-line prompt into a merged PR using any combination of models, sandboxes, and quality gates.

## Why?

Existing multi-agent tools spawn agents and hope for the best. pi-stories enforces **deterministic gates between every non-deterministic step** — the [D]/[N] pattern that Stripe and Mario Zechner proved at scale.

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

## 34 Commands

### Core (v0.1)
| Command | Description |
|---------|-------------|
| `init` | Create `.pi-stories/` with auto-detected gates |
| `run <task>` | Execute Blueprint Engine [D]/[N] pipeline |
| `status` | Active agents, recent runs, system state |
| `config` | View current configuration |
| `version` | Build info |

### Observability (v0.2)
| Command | Description |
|---------|-------------|
| `costs` | Token/cost breakdown (by tier, runtime, run) |
| `trace <run-id>` | Chronological event timeline |
| `replay <run-id>` | Replay agent actions with timing |
| `logs` | Query NDJSON event logs |
| `dashboard` | Live TUI dashboard with auto-refresh |
| `export <run-id>` | Export run as shareable JSON report |

### Multi-Agent (v0.3)
| Command | Description |
|---------|-------------|
| `sling <task>` | Spawn a single named agent |
| `parallel <task>` | Launch N agents simultaneously |
| `mail send` | Send inter-agent message |
| `mail check` | Check inbox (priority-sorted) |
| `mail list` | List all messages |
| `mail read <id>` | Mark as read |
| `mail reply <id>` | Reply to a message |
| `mail purge` | Delete old messages |
| `merge` | Merge agent branches (tiered conflict resolution) |
| `queue` | Show merge queue |
| `nudge <agent>` | Poke a stalled agent |
| `stop <agent>` | Terminate an agent |

### Full System (v0.4)
| Command | Description |
|---------|-------------|
| `doctor` | 11-category health check |
| `watch` | Watchdog daemon (stall detection, cost ceiling) |
| `agents` | List all 18 runtimes and their availability |
| `sessions` | List agent sessions |
| `inspect <agent>` | Deep inspection of agent state |
| `monitor <agent>` | Real-time output stream |
| `worktree <action>` | Manage git worktrees for parallel agents |
| `clean` | Clean runtime state (runs, mail, sessions) |

### Thread Scorecard
| Command | Description |
|---------|-------------|
| `scorecard` | Weekly improvement across 4 dimensions (auto-tracked) |

## Architecture

```
.pi-stories/
  config.yaml          # Runtimes, models, budget, gates
  mail.db              # SQLite — inter-agent messaging
  sessions.db          # SQLite — agent lifecycle tracking
  merge-queue.db       # SQLite — FIFO merge queue
  costs.db             # SQLite — aggregate cost history
  threads.db           # SQLite — thread metrics + scorecards
  runs/
    {run-id}/
      status.json      # Pipeline state (resumable)
      events.jsonl     # Event log (trace/replay)
      {step-id}.json   # Agent output per step
  worktrees/
    {branch}/          # Isolated git worktrees
```

## 18 Runtimes

**Local agents:** pi, claude, gemini-cli, codex, aider, goose, amp, cursor, antigravity, gemini
**Remote backends:** gh-agent, jules, e2b
**Platform:** openclaw
**Tools:** docker, gh, beepctl, pi-messenger

## Cost Routing

| Tier | Role | Default Model | ~Cost/call |
|------|------|---------------|------------|
| 1 | Scout, triage | claude-haiku-4-5 | $0.001 |
| 2 | Build, plan | claude-sonnet-4-5 | $0.01 |
| 3 | Review, architect | claude-opus-4-5 | $0.10 |

Budget ceiling enforced per-step. Watchdog enforces daily ceiling.

## Merge Queue

4-tier conflict resolution:
1. **Textual auto-merge** — git handles it
2. **Ours/theirs heuristic** — lockfiles, config
3. **AI resolver** — agent analyzes the conflict
4. **Human required** — opens for manual resolution

## Thread-Based Engineering

Every pi-stories command is a thread. Threads are classified automatically — you just use `run`, `sling`, and `parallel` as normal:

| Thread | You run | What it means |
|--------|---------|---------------|
| **base** | `sling <task>` | Single agent, single prompt |
| **P** | `parallel <task>` | N agents on independent tasks |
| **C** | `run <task>` | [D]/[N] pipeline with gates |
| **F** | `parallel --fusion <task>` | Same task × N, pick best |
| **B** | `run` with sub-agents | Agents spawning agents |
| **L** | `sling --long <task>` | Extended autonomy (hours) |
| **Z** | `sling --no-review <task>` | Zero-touch, maximum trust |

```bash
# Your weekly improvement — tracked automatically
pi-stories scorecard --save
pi-stories scorecard --history 12
```

**The Four Scaling Dimensions** (from [IndyDevDan](https://agenticengineer.com/thinking-in-threads)):
1. **Width** — More parallel threads (P-threads)
2. **Time** — Longer autonomous runs (L-threads)
3. **Depth** — Agents managing agents (B-threads)
4. **Attention** — Fewer checkpoints needed (Z-threads)

## Compared to Overstory

| Feature | Overstory | pi-stories |
|---------|-----------|------------|
| Commands | 32 | **34** |
| Core pattern | Sequential pipeline | **[D]/[N] interleaving** |
| Thread types | None | **7 types** (base, P, C, F, B, L, Z) |
| Cost routing | None | **3-tier auto-escalation** |
| Budget control | After the fact | **Per-run + daily ceiling** |
| Retry strategy | Manual | **Auto-retry with escalation** |
| Databases | 4 SQLite | **5 SQLite** (mail, sessions, merge, costs, threads) |
| Gate detection | Manual | **Auto-detect** |
| Runtimes | 4 | **18** |
| Conflict resolution | None | **4-tier merge** |
| Watchdog | Basic | **Stall detection + cost ceiling + auto-kill** |
| Parallel agents | Yes | **Yes + git worktrees + F-threads** |
| Health check | 11 categories | **11 categories** |
| Improvement tracking | None | **Weekly scorecard** (4 dimensions) |

## Tech Stack

- **Runtime:** Bun
- **Language:** TypeScript (strict mode)
- **CLI:** Commander.js
- **Databases:** bun:sqlite (WAL mode)
- **Linting:** Biome
- **Output:** chalk

## License

MIT
