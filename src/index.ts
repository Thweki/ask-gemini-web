import { settings, type Settings } from './config.js';
import { compileJob, execute, runSummary } from './jobs.js';

/** One-call local drafting: discover, route, select, submit, collect, persist. */
export async function draft(input: unknown, config: Settings = settings({})) {
  return runSummary(await execute(config, await compileJob(input), () => {}));
}
export { compileJob, loadJob, resume, runSummary } from './jobs.js';
