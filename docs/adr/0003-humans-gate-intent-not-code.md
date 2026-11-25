---
Status: superseded in part by ADR 0005 (no PR Gate for a repository without CI)
---

# Humans gate intent; code review only in Work Mode

The owner approves Specs (always) and the Ticket split (Work Mode; optional in Personal Mode). Code is reviewed by a human only in Work Mode, where teammates share the repository; in Personal Mode a Run's change merges when automated checks pass, and the PR Gate switches back on for a repository without CI. Between Gates a Run may stop for a human only for an ambiguous Spec, a missing secret or access, a destructive operation, or an exhausted iteration budget. We chose this because errors in intent are the expensive ones, and reviewing every line is what makes factories slow.
