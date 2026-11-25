# ai-memory is the only store for Learned Facts

Rules live in `AGENTS.md` files the owner edits on purpose. Facts the factory learns while working are captured only by ai-memory; Claude Code's built-in auto-memory is turned off inside Runs. Two automatic memory stores would drift and contradict each other, and ai-memory's git-backed markdown is inspectable and costs no model calls to capture.
