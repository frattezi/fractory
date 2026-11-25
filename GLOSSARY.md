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
The Mode for repositories only the owner maintains, where changes that pass automated checks merge without human review.

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

**Run**:
One agent attempt at one Ticket, from start to finish, without a human in the loop.
_Avoid_: job, execution, session

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

**Trigger**:
A detectable change of state that starts a Run without anyone asking: a Ticket becoming ready, a failed check on a Run's change, or a review comment on it.
_Avoid_: event, hook

### Knowledge

**Rule**:
An instruction the owner writes on purpose to govern how agents work.
_Avoid_: memory, preference

**Learned Fact**:
Something the factory captured automatically while working, kept so later Runs don't rediscover it.
_Avoid_: rule, note
