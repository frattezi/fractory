import { resolve } from 'node:path';
import {
  AUTOMATION_RUN_RECORD_VERSION,
  type AutomationRequest,
  parseAutomationRequest,
} from '../contracts/automation.ts';
import type { FactoryConfig } from '../contracts/factory-config.ts';
import { AutomationStore, REFUSAL_VERSION, automationRunId } from '../registry/automations.ts';
import type { Logger } from './support.ts';

export interface AcceptDeps {
  factory: Pick<FactoryConfig, 'automationsDir' | 'repos'>;
  now(): Date;
  log: Logger;
}

export interface AcceptSummary {
  /** Automation Run ids queued from new requests. */
  queued: string[];
  /** Request file names refused. */
  refused: string[];
  /** Request file names discarded because their instant already has a record. */
  discarded: string[];
  errors: number;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

type Verdict = { ok: true; request: AutomationRequest } | { ok: false; reason: string };

const judge = (text: string, repos: readonly string[]): Verdict => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `Invalid Automation request: not JSON (${message(error)})` };
  }
  const parsed = parseAutomationRequest(raw);
  if (!parsed.ok) return parsed;
  const repoPath = parsed.value.automation.repoPath;
  if (!repos.some((repo) => resolve(repo) === resolve(repoPath))) {
    return {
      ok: false,
      reason: `Unknown repository ${repoPath}: it is not one of the factory's configured repos`,
    };
  }
  return { ok: true, request: parsed.value };
};

/**
 * Turns the Automation requests in the request directory into queued Automation Run records.
 * Nothing is executed here, and these Runs never touch a Ticket or a pull request.
 *
 * For each request file: a valid, unseen request becomes a `queued` record; a request whose
 * instant already has a record is discarded; anything else is refused with its reason. In every
 * case the record or refusal is written first and the request file removed afterwards, so a crash
 * in between leaves a file that the next tick discards instead of running twice.
 */
export const acceptAutomationRequests = async (deps: AcceptDeps): Promise<AcceptSummary> => {
  const summary: AcceptSummary = { queued: [], refused: [], discarded: [], errors: 0 };
  const { log, factory } = deps;
  const store = new AutomationStore(factory.automationsDir);
  const fail = (what: string, error: unknown): void => {
    summary.errors++;
    log.error(`${what}: ${message(error)}`);
  };

  let names: string[];
  try {
    names = await store.listRequests();
  } catch (error) {
    fail('Automation requests', error);
    return summary;
  }

  for (const name of names) {
    try {
      let text: string;
      try {
        text = await store.readRequest(name);
      } catch (error) {
        // Gone since listing, or unreadable for now: a failed read proves nothing; try next tick.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          fail(`Automation request ${name}`, error);
        continue;
      }
      const verdict = judge(text, factory.repos);
      if (!verdict.ok) {
        await store.writeRefusal({
          version: REFUSAL_VERSION,
          request: name,
          reason: verdict.reason,
          refusedAt: deps.now().toISOString(),
          content: text,
        });
        await store.removeRequest(name);
        summary.refused.push(name);
        log.warn(`Automation request ${name} refused: ${verdict.reason}`);
        continue;
      }

      const { automation, firedFor } = verdict.request;
      if (await store.hasRunFor(automation.id, firedFor)) {
        await store.removeRequest(name);
        summary.discarded.push(name);
        log.info(
          `Automation request ${name} discarded: ${automation.id} already has a Run for ${firedFor}`,
        );
        continue;
      }

      const id = automationRunId(automation.id, firedFor);
      const stamp = deps.now().toISOString();
      // The copy first: a record never exists without the configuration it runs.
      await store.writeRequestCopy(id, verdict.request);
      await store.writeRun({
        version: AUTOMATION_RUN_RECORD_VERSION,
        id,
        automationId: automation.id,
        firedFor,
        status: 'queued',
        startedAt: stamp,
        updatedAt: stamp,
        logPath: store.logPath(automation.id, id),
        outputPath: store.outputPath(automation.id, id),
      });
      await store.removeRequest(name);
      summary.queued.push(id);
      log.info(`queued Automation Run ${id} for ${automation.id} (fired for ${firedFor})`);
    } catch (error) {
      fail(`Automation request ${name}`, error);
    }
  }
  return summary;
};
