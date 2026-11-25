# Installing Fractory

Fractory is configuration, not an app (ADR 0001): skills, rules and tested scripts that a Claude Code
session loads.

## 1. Skills

From a clone of this repository:

```sh
pnpm install
pnpm fractory install            # copies skills/* into ~/.claude/skills
pnpm fractory install --target <dir>   # another skills directory
```

`install` overwrites only the skill directories it owns, marked by a `.fractory-owned` file. A
same-named directory without the marker is skipped and reported, and every other skill is left
alone. Re-run it after pulling to update. Start a new Claude Code session to pick the skills up:
`grill-with-docs`, `to-spec`, `to-tickets`, `research`, `handoff`.

## 2. Register a repository

```sh
pnpm fractory init <repo> --mode personal --github owner/name --ci
pnpm fractory init <repo> --mode work --jira-url https://acme.atlassian.net --jira-project ABC \
  --jira-status-ready "Ready" --jira-status-in-progress "In Progress" \
  --jira-status-in-review "In Review" --jira-status-done "Done" --ci
```

This writes and validates `<repo>/.fractory.json` (Mode, Ticket source, CI, Ticket Gate, base
branch, sandbox image, iteration budget). It refuses to overwrite an existing file unless `--force`
is passed. Commit the file: the Mode belongs to the repository.

## 3. Learned Facts: ai-memory

Learned Facts are captured only by ai-memory (ADR 0004).

```sh
ai-memory setup
```

Run it once on the machine, following its prompts, so it hooks into your agent sessions.

## 4. Turn off built-in auto-memory for Runs

Two automatic memory stores would drift apart, so Claude Code's own auto-memory must be off inside
every Run. Set it in the environment the Run's agent starts with:

```sh
export CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
```

The Run executor sets this for the agent process it launches; export it yourself only for sessions
you run by hand and want to behave like a Run. Your interactive sessions can keep auto-memory on
if you want it.

## 5. Fractory Manager (the Agent Manager fork)

The Runs view lives in our fork of Agent Manager, `frattezi/agent-manager`, branch
`fractory/runs-view` (ADR 0002). Build it as its own binary so the upstream `agent-manager` stays
installed:

```sh
cd ~/Work/Personal/agent-manager
make build VERSION=0.50.0-fractory
install -m 755 agent-manager ~/.local/bin/fractory-manager && rm agent-manager
```

It reads Runs from `$FRACTORY_HOME/runs` (default `~/.fractory/runs`) and shares Agent Manager's
config, sessions and tmux namespace, so run one of the two at a time, not both. Review comments
on a Run are saved to `<id>.comments.json`; the next `tick` turns them into a follow-up Run.
