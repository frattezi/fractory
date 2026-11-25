import type { Flow } from '../src/flows/types.ts';

/** One agent, one `worktree.run`: implement the Ticket, or fix the CI failure / review comment. */
const build: Flow = async (ctx) => {
  const prompt = ctx.buildPrompt({
    rules: ctx.rules,
    ticket: ctx.ticket,
    followUp: ctx.followUp,
  });
  const result = await ctx.worktree.run({
    agent: await ctx.agents.claude(),
    sandbox: ctx.sandbox,
    prompt,
    maxIterations: ctx.maxIterations,
    completionSignal: ctx.completionSignal,
    logging: { type: 'file', path: ctx.logPath },
  });

  const parsed = ctx.parseRunResult(result.stdout);
  if (parsed) return parsed;
  if (result.completionSignal !== undefined) {
    return { outcome: 'failed', summary: 'The agent finished without a valid result block.' };
  }
  return {
    outcome: 'needs-human',
    reason: 'budget-exhausted',
    question: `The agent used all ${ctx.maxIterations} iterations on ${ctx.ticket.ref} without finishing. Raise maxIterations or split the Ticket?`,
  };
};

export default build;
