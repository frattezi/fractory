import { describe, expect, it } from 'vitest';
import { parseRelations, renderRelations } from '../src/adapters/relations.ts';

const own = 'github:me/app#9' as const;

describe('relations', () => {
  it('renders a Relations section that parses back to the same relations', () => {
    const relations = {
      blockedBy: ['github:me/app#4', 'jira:ABC-5'] as const,
      parent: 'github:me/app#1' as const,
    };
    const body = renderRelations('Do it.\n', { ...relations, blockedBy: [...relations.blockedBy] });
    expect(body).toBe(
      'Do it.\n\n## Relations\n\nBlocked by: github:me/app#4\nBlocked by: jira:ABC-5\nParent: github:me/app#1',
    );
    expect(parseRelations(body, own)).toEqual({
      blockedBy: ['github:me/app#4', 'jira:ABC-5'],
      parent: 'github:me/app#1',
      errors: [],
    });
  });

  it('leaves a body without relations untouched', () => {
    expect(renderRelations('Do it.', { blockedBy: [] })).toBe('Do it.');
  });

  it('reads no relations from a body without a Relations section', () => {
    expect(parseRelations('Just prose.\n\n## Blocked by\n\nNone', own)).toEqual({
      blockedBy: [],
      errors: [],
    });
    expect(parseRelations('', own)).toEqual({ blockedBy: [], errors: [] });
    expect(parseRelations('Waiting.\n\nBlocked by the API team', own).blockedBy).toEqual([]);
  });

  it('reads the older prose form, resolving shorthand against the own repository', () => {
    const body = 'B\n\nParent: #1\nBlocked by #2\nBlocked by other/lib#3\nBlocked by ABC-4';
    expect(parseRelations(body, own)).toEqual({
      blockedBy: ['github:me/app#2', 'github:other/lib#3', 'jira:ABC-4'],
      parent: 'github:me/app#1',
      errors: [],
    });
  });

  it('reports a `#n` shorthand on a Ticket that has no GitHub repository', () => {
    expect(parseRelations('B\n\nBlocked by #2', 'jira:ABC-1')).toEqual({
      blockedBy: [],
      errors: ['Blocked by: "#2" is not a Ticket ref'],
    });
  });

  it('reports malformed refs and unreadable lines instead of dropping them', () => {
    const body = [
      'B',
      '',
      '## Relations',
      '',
      'Blocked by: github:me/app#4, github:me/app#x',
      'Blocked by:',
      'Parent: github:me/app#1',
      'Parent: github:me/app#2',
      'Depends on github:me/app#5',
    ].join('\n');
    expect(parseRelations(body, own)).toEqual({
      blockedBy: ['github:me/app#4'],
      parent: 'github:me/app#1',
      errors: [
        'Relations: cannot read "Depends on github:me/app#5"',
        'Blocked by: "github:me/app#x" is not a Ticket ref',
        'Blocked by: no Ticket ref given',
        'Parent: "github:me/app#2" is a second parent (already github:me/app#1)',
      ],
    });
  });

  it('accepts owner edits: list markers, several refs on a line, duplicates', () => {
    const body = '## Relations\n\n- Blocked by: github:me/app#4 github:me/app#5\n- blocked by #4';
    expect(parseRelations(body, own)).toEqual({
      blockedBy: ['github:me/app#4', 'github:me/app#5'],
      errors: [],
    });
  });

  it('stops the section at the next heading', () => {
    const body = '## Relations\n\nBlocked by: github:me/app#4\n\n## Notes\n\nAnything goes';
    expect(parseRelations(body, own)).toEqual({ blockedBy: ['github:me/app#4'], errors: [] });
  });
});
