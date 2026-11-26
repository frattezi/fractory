import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { NeedsHumanReasonSchema, RunResultSchema } from '../src/contracts/run.ts';

describe('rules/run-agent.md', () => {
  it('names every needs-human reason and a RunResult example per outcome that validates', async () => {
    const text = await readFile(new URL('../rules/run-agent.md', import.meta.url), 'utf8');
    for (const reason of NeedsHumanReasonSchema.options) expect(text).toContain(`\`${reason}\``);

    const examples = [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
    const valid = examples.flatMap((json) => {
      const candidate = JSON.parse(json);
      if (candidate.outcome === 'needs-human') candidate.reason = 'ambiguous-spec';
      return RunResultSchema.safeParse(candidate).success ? [candidate.outcome] : [];
    });
    expect(valid.sort()).toEqual(['done', 'failed', 'needs-human']);
  });

  it('describes the Answer path and that an answer is binding', async () => {
    const text = await readFile(new URL('../rules/run-agent.md', import.meta.url), 'utf8');
    expect(text).toContain('the owner answers your question');
    expect(text).toContain('continues on the same branch');
    expect(text).toContain('answered on its own');
    expect(text).toContain('it is binding');
  });
});
