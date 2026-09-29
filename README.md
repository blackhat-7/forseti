# Forseti

**A small LLM benchmark you run on your own machine, with your own logins. It only claims what its evidence shows.**

Forseti gives models real tasks, grades them with hidden deterministic checks, and shows the result in a terminal UI. You can watch every model think and act live.

![Two Claude tries streaming in the Live tab](docs/live.gif)

*The Live tab replaying two real tries. On the right, the model notices its `kubectl` points at staging, not prod, before touching anything.*

## Why it exists

- **Your tasks, your logins.** Runs through your Claude plan, any provider the Pi agent library supports, or a local model. No API key is needed for Claude.
- **Hidden checks, not vibes.** Every task is graded by code the model never sees, with evidence you can read.
- **Honest numbers.** A crash or an expired login is never scored as a wrong answer. A gap within the noise is called a tie, not a ranking.
- **Safe to run.** Code a model writes runs in an OS sandbox with no network and no access outside its folder.

## Quick start

Needs macOS or Linux (kernel 6.12+), Node 24+ and Python 3.

```sh
mkdir -p .tmp && TMPDIR="$PWD/.tmp" npm ci
npm run demo      # a full run with synthetic controls; no model, no quota
npm start         # the terminal UI
```

## Run a model

```sh
# Claude, under the Claude Code login you already have
npm start -- models add claude-code/sonnet
npm start -- run --models claude-code-sonnet --repeat 2

# A local model (llama-server, Ollama, LM Studio, vLLM)
npm start -- local http://127.0.0.1:8080
npm start -- models add local/MODEL_ID

# Any Pi provider
npm start -- models catalog openai-codex
npm start -- models add openai-codex/gpt-5.5 --auth pi
```

A run only makes the tries that are missing. Anything already on record under the same conditions is reused.

## The screens

**Home: the leaderboard,** split by difficulty, with the error margin next to every score.

![Leaderboard](docs/tui-home.svg)

**Runs: every run,** with the evidence behind each check one key away.

![Runs](docs/tui-runs.svg)

**Tests: what each task measures,** with its prompt.

![Tests](docs/tui-tests.svg)

Keys: `1`–`6` switch tabs, `r` starts a run, `?` lists everything else.

## What it tests

31 tasks in three tiers (`basic`, `standard`, `hard`), each scored separately so easy tasks can't pad a strong model's number. Most are code: fix a shared parser, write an exact SQL query, reconcile three sources that disagree.

**Production operations.** Three hard tasks put the model on call:

| Task | The situation |
|---|---|
| `checkout-hotfix` | Checkout is down for millions of users after a deploy. Every minute costs orders. |
| `subscription-repair` | A bad scheduled job is cancelling paying customers in the production database. |
| `bucket-residency` | Move a live 2.3 TiB uploads bucket to the EU with no downtime and no lost file. |

The model gets a terminal with `gcloud`, `kubectl`, `psql` and `gsutil` and is not told anything is simulated. **Nothing real is reachable:** every command is answered in-process from made-up state, so no program runs and nothing touches the network. Each task is full of traps (the wrong cluster, a flag change that restarts the database, a copy that misses new uploads) and runs on a clock. Too careless and something breaks; too cautious and the outage keeps costing orders.

## Commands

| | |
|---|---|
| `npm start` | the terminal UI |
| `npm start -- run --models A,B --tests X,Y --repeat N` | run models on tasks |
| `npm start -- leaderboard` | every comparable try, ranked where the evidence allows |
| `npm start -- compare RUN_ID` | one run's report |
| `npm start -- regrade` | grade saved tries again after a grader change, without calling a model |
| `npm start -- tells` | where a model suspected an ops task was staged, so the fake estate can be made more convincing |
| `npm test` · `npm run test:suite` | framework tests · check every grader against its reference and flawed answer |

## Learn more

- [Reference](docs/reference.md): every flag, lane, billing rule and check
- [Writing tasks](docs/suite-contract.md), including [production-ops tasks](docs/suite-contract.md#world-tasks)
- [Judging design quality](docs/judging.md) · [Security](docs/security.md) · [Verification](docs/verification.md)
- Working on Forseti: start with [AGENTS.md](AGENTS.md)

Screenshots and the video are the real UI: `npm run screenshot [home|live|models|tests|runs]` and `node tools/replay.ts RUN_ID TRIAL_ID[,TRIAL_ID]` regenerate them.
