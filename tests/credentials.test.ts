import { describe, expect, it } from 'vitest';
import {
  MissingCredentialError,
  credentialKeysIn,
  resolveCredentials,
} from '../src/runner/credentials.ts';
import type { Exec } from '../src/runner/exec.ts';

const keychain =
  (items: Record<string, string>, calls: string[][] = []): Exec =>
  async (file, args) => {
    calls.push([file, ...args]);
    const secret = items[args[args.indexOf('-s') + 1] ?? ''];
    if (secret === undefined) throw Object.assign(new Error('nope'), { code: 44 });
    return { stdout: `${secret}\n`, stderr: '' };
  };

describe('resolveCredentials', () => {
  it('reads the Claude work token from its Keychain service', async () => {
    const calls: string[][] = [];
    const env = await resolveCredentials(
      { kind: 'claude', account: 'work' },
      keychain({ 'fractory.claude.work': 'tok' }, calls),
    );
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
    expect(calls).toEqual([
      ['security', 'find-generic-password', '-s', 'fractory.claude.work', '-w'],
    ]);
  });

  it('keeps the personal accounts apart', async () => {
    const items = { 'fractory.claude.personal': 'p', 'fractory.opencode.personal': 'k' };
    expect(
      await resolveCredentials({ kind: 'claude', account: 'personal' }, keychain(items)),
    ).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'p',
    });
    expect(
      await resolveCredentials({ kind: 'opencode', account: 'personal' }, keychain(items)),
    ).toEqual({
      OPENCODE_API_KEY: 'k',
    });
  });

  it('names the exact service when the item is missing', async () => {
    const error = await resolveCredentials({ kind: 'claude', account: 'work' }, keychain({})).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(MissingCredentialError);
    expect(error.question).toContain('fractory.claude.work');
    expect(error.question).toContain('security add-generic-password -s fractory.claude.work');
  });

  it('treats an empty secret as missing', async () => {
    await expect(
      resolveCredentials(
        { kind: 'claude', account: 'work' },
        keychain({ 'fractory.claude.work': '' }),
      ),
    ).rejects.toBeInstanceOf(MissingCredentialError);
  });

  it('does not call another failure "missing" and never leaks the secret in it', async () => {
    const exec: Exec = async () => {
      throw Object.assign(new Error('User interaction is not allowed. tok'), { code: 36 });
    };
    const error = await resolveCredentials({ kind: 'claude', account: 'work' }, exec).catch(
      (e) => e,
    );
    expect(error).not.toBeInstanceOf(MissingCredentialError);
    expect(error.message).toContain('fractory.claude.work');
  });
});

describe('credentialKeysIn', () => {
  it('finds credential keys, even empty or exported', () => {
    expect(
      credentialKeysIn(
        'GH_TOKEN=x\nexport ANTHROPIC_API_KEY=\n# CLAUDE_CODE_OAUTH_TOKEN=y\nOPENCODE_API_KEY="z"',
      ),
    ).toEqual(['ANTHROPIC_API_KEY', 'OPENCODE_API_KEY']);
  });
});
