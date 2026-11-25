# Sandcastle runs the factory; Agent Manager only shows it, through the Run registry

Every Run started by a Trigger executes through Sandcastle in a sandbox, and only Sandcastle creates worktrees for Runs. The Agent Manager fork never attaches to a running sandbox: it reads the Run registry (one JSON file per Run) to list Runs, show logs and open its diff review on a Run's worktree, and review comments start a new Run through a Trigger.

## Considered Options

- **Link the tools through worktree folder layout.** Rejected: Agent Manager only knows tmux sessions it launched, Sandcastle's folder names are internal to it, and a Claude Code conversation recorded inside a container is keyed to the container's path, so it can't be resumed reliably on the host.
- **Live takeover of a running sandbox from Agent Manager.** Rejected: it creates an undefined fourth Gate and defeats the sandbox.

## Consequences

The registry file format is a public contract: changing it means changing both Fractory and the fork. The fork's diff against upstream stays to one read-only view plus one action, because Agent Manager has no plugin API.
