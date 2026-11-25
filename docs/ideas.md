# Ideas backlog

Ideas to pick up after v1. Not specs yet: each goes through grilling and a Spec before any work.
Ideas for Fractory Manager (the Agent Manager fork) live in `frattezi/agent-manager`, branch
`fractory/runs-view`, `docs/fractory-ideas.md`.

## 1. A hard guard for factory branches

The `fractory` skill asks interactive agents to stay off the branches `fractory status` lists as
hands-off, but nothing enforces it. Add a `pre-commit` and `pre-push` hook to each managed repo's
main checkout that calls `fractory status --json` and refuses a commit or push on a factory branch,
the way Run worktrees already refuse pushes to the base branch.
