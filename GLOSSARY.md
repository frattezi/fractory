# Fractory

A personal software factory: the rules, skills and flows that turn a Goal into merged code, with humans stepping in only at defined points.

## Language

### The factory

**Fractory**:
The package of configuration, skills and deterministic flows that any agent session loads to work as the factory. It has no user interface of its own.
_Avoid_: Fractory TUI, the app

**Mode**:
The level of human oversight a repository requires: either Work Mode or Personal Mode. It belongs to the repository, not to the session.
_Avoid_: profile, environment

**Work Mode**:
The Mode for repositories shared with other developers, where every change passes human review before merge.

**Personal Mode**:
The Mode for repositories only the owner maintains, where changes merge without human review, with or without automated checks.

### Units of work

**Goal**:
An outcome the owner wants, stated before any design work has happened.
_Avoid_: task, job, stuff to do

**Spec**:
A Goal after it has been grilled and agreed: what will be built and why.
_Avoid_: PRD, design doc

**Ticket**:
One slice of a Spec small enough for a single agent to build and ship on its own.
_Avoid_: task, issue, story

**Quick Ticket**:
A Ticket written straight from a conversation for a small, settled change, with a short brief in place of a Spec. The owner approving the brief passes the Spec Gate for it.
_Avoid_: hotfix, chore

**Run**:
One agent attempt at one Ticket, from start to finish, without a human in the loop.
_Avoid_: job, execution, session

**Re-run**:
A new Run the owner asks for on a Ticket whose latest Run failed or needed a human, continuing on that Ticket's branch. Unlike a follow-up Run, which a Trigger starts, only the owner starts a Re-run.
_Avoid_: retry, restart

### Human oversight

**Gate**:
A fixed point where work stops until a human approves it.
_Avoid_: checkpoint, approval step

**Spec Gate**:
The Gate where the owner approves a Spec. It applies in every Mode.

**Ticket Gate**:
The Gate where the owner approves how a Spec was split into Tickets. Required in Work Mode, optional in Personal Mode.

**PR Gate**:
The Gate where a human reviews a Run's change before it merges. Applies only in Work Mode.

**Auto-merge**:
Fractory merging a Personal Mode change by itself once the Run is done and the change is mergeable with passing or no checks. It never happens in Work Mode.

**Trigger**:
A detectable change of state that starts a Run without anyone asking: a Ticket becoming ready, a failed check on a Run's change, or a review comment on it.
_Avoid_: event, hook

**Host Limits**:
The ceilings on the machine's CPU and memory, both on the computer itself and in the sandbox where Runs execute, above which no new Run starts. Runs already running are never stopped by them.
_Avoid_: budget, capacity, quota

**Held**:
The state of the queue while the machine is over its Host Limits: queued Runs wait and start once it has room again. It describes the machine, not a Run.
_Avoid_: paused, throttled

### Agents and flows

**Agent Profile**:
One coding agent paired with the Account it runs on, such as Claude on the personal Account.

**Account**:
Whose subscription pays for and answers for an agent's work: work or personal. It follows the Mode and cannot be overridden.

**Flow**:
The fixed sequence of steps a Run follows to turn a Ticket into a change. Each repository names the Flow it uses.

**Rebuild**:
Refreshing what the owner runs from a repository's current checkout, by running the commands its `.fractory.json` lists under `rebuild`. It never touches git and is only started by the owner, with `fractory rebuild`.
_Avoid_: deploy, update, sync

### Knowledge

**Rule**:
An instruction the owner writes on purpose to govern how agents work.
_Avoid_: memory, preference

**Learned Fact**:
Something the factory captured automatically while working, kept so later Runs don't rediscover it.
_Avoid_: rule, note
