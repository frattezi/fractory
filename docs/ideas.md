# Ideas backlog

Ideas to pick up after v1. Not specs yet: each goes through grilling and a Spec before any work.

## 1. Draft review links in Agent Manager after a PR review

When a PR-review task finishes, Agent Manager shows a list of the draft reviews it produced, with
their URLs, so the owner can open and submit them. At that point the review agent ends itself and
its worktree is cleaned up: nothing stays running or on disk once the drafts exist.

## 2. Fractory Manager: a live map of the factory

Rename the Agent Manager fork to **Fractory Manager** and add a TUI view of the agents that are
working right now and how they connect: which Runs belong to which Ticket and Spec, which agent and
account each uses, and which Triggers started them. A large visual piece that needs its own design
pass.

## 3. Terminal and chat side by side in Fractory Manager

Show an agent's chat and one of its nested terminals in two panes at once, instead of switching
between rows. Today the split view is the session list plus a single preview; the workaround is an
outer terminal split running `tmux attach -t am_<name>`. Could share the multi-pane work with idea 2.
