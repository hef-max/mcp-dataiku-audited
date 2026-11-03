import { z } from 'zod';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { errorDetails, sanitize } from './dss-error.js';

const identifier = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/).max(255);
const jobId = z.string().min(1).max(1024).refine(v => v !== '.' && v !== '..' && !/[\\/\r\n]/.test(v), 'Invalid job/activity ID');
const timeout = z.number().int().min(1).max(3600).default(60);
const fields = { project_key: identifier, mode: z.enum(['NON_RECURSIVE_FORCED_BUILD', 'RECURSIVE_FORCED_BUILD']).default('NON_RECURSIVE_FORCED_BUILD'),
  wait: z.boolean().default(false), timeout_seconds: timeout, dry_run: z.boolean().default(false) };
export const buildDatasetSchema = z.strictObject({ ...fields, dataset_name: identifier });
export const runRecipeSchema = z.strictObject({ ...fields, recipe_name: identifier });
export const jobStatusSchema = z.strictObject({ project_key: identifier, job_id: jobId });
export const waitForJobSchema = jobStatusSchema.extend({ timeout_seconds: timeout });
export const jobLogSchema = jobStatusSchema.extend({ activity_id: jobId.optional(), max_chars: z.number().int().min(100).max(20000).default(8000) });
export type BuildDatasetRequest = z.input<typeof buildDatasetSchema>;
export type RunRecipeRequest = z.input<typeof runRecipeSchema>;
export type JobRequest = z.input<typeof jobStatusSchema>;
export interface BuildResult {
  project_key: string; dataset_name: string; job_id: string;
  state: 'RUNNING' | 'SUCCESS' | 'FAILED' | 'ABORTED';
  started_at?: string; finished_at?: string; outputs: string[];
  error?: { message: string; activity_id?: string; log_excerpt?: string };
  timed_out?: boolean; monitoring_error?: unknown; dss_state?: string;
}
interface Transport {
  get(path: string, options?: { timeoutMs?: number }): Promise<{data: any}>;
  getText(path: string, options?: { timeoutMs?: number }): Promise<{data: string}>;
  post(path: string, body: unknown): Promise<{data: any}>;
}
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function items(roles: any): any[] { return Object.values(roles ?? {}).flatMap((r: any) => r.items ?? []); }
function iso(value: any): string | undefined {
  if (!value) return undefined;
  const date = new Date(value); return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

export class JobService {
  constructor(private readonly http: Transport, private readonly apiKey = '',
    private readonly clock = { now: () => Date.now(), sleep: (ms: number) => sleepTimer(ms) }) {}

  private async plan(request: z.output<typeof buildDatasetSchema>, recipeName?: string) {
    const root = `/projects/${request.project_key}`;
    await this.http.get(root);
    const dataset = (await this.http.get(`${root}/datasets/${request.dataset_name}`)).data;
    check(dataset?.name === request.dataset_name, 'Invalid dataset response');
    check(!dataset.partitioning?.dimensions?.length, 'Partitioned builds require an explicit partition API; not supported by this tool');
    const recipes = (await this.http.get(`${root}/recipes/`)).data as any[];
    const localRef = (ref: string) => ref === request.dataset_name || ref === `${request.project_key}.${request.dataset_name}`;
    const producers = recipes.filter(r => items(r.outputs).some(o => localRef(o.ref)));
    check(producers.length === 1, producers.length ? 'Ambiguous dataset producer' : 'Dataset has no producer recipe');
    check(!recipeName || producers[0].name === recipeName, 'Recipe is not the unique producer of this dataset');
    const outputs = items(producers[0].outputs);
    check(outputs.length === 1 && localRef(outputs[0].ref), 'Producer has multiple or ambiguous outputs; refusing to build additional objects');
    check(!outputs[0].appendMode, 'Append-mode outputs are not supported by this build tool');
    const body = { type: request.mode, refreshHiveMetastore: false, autoUpdateSchemaBeforeEachRecipeRun: false,
      outputs: [{ type: 'DATASET', id: request.dataset_name, projectKey: request.project_key, partition: null }] };
    return { root, body, producer: producers[0].name };
  }

  async runRecipe(input: unknown) {
    const request = runRecipeSchema.parse(input);
    const envelope = (await this.http.get(`/projects/${request.project_key}/recipes/${request.recipe_name}`)).data;
    const outputs = items(envelope.recipe?.outputs);
    check(outputs.length === 1 && typeof outputs[0].ref === 'string' && !outputs[0].appendMode, 'Recipe requires exactly one unambiguous, non-append dataset output');
    const ref = outputs[0].ref;
    const name = ref.startsWith(request.project_key + '.') ? ref.slice(request.project_key.length + 1) : ref;
    check(!name.includes('.'), 'Cross-project recipe outputs are unsupported');
    const { recipe_name, ...options } = request;
    return this.build({ ...options, dataset_name: name }, recipe_name);
  }

  async build(input: unknown, recipeName?: string) {
    const request = buildDatasetSchema.parse(input);
    const plan = await this.plan(request, recipeName);
    if (request.dry_run) return { dry_run: true, writes: 0, project_key: request.project_key, dataset_name: request.dataset_name,
      producer: plan.producer, endpoint: `${plan.root}/jobs/`, job_definition: plan.body };
    const created = (await this.http.post(`${plan.root}/jobs/`, plan.body)).data;
    check(typeof created?.id === 'string' && created.id.length, 'DSS returned no job ID. Job submission may have succeeded; inspect jobs before retrying');
    const result: BuildResult = { project_key: request.project_key, dataset_name: request.dataset_name, job_id: created.id,
      state: 'RUNNING', outputs: [request.dataset_name] };
    if (!request.wait) return result;
    try { return await this.wait({ project_key: request.project_key, job_id: created.id, timeout_seconds: request.timeout_seconds }); }
    catch (error) { return { ...result, monitoring_error: sanitize(errorDetails(error), this.apiKey) }; }
  }

  async details(input: unknown, timeoutMs?: number) {
    const request = jobStatusSchema.parse(input);
    return sanitize((await this.http.get(`/projects/${request.project_key}/jobs/${encodeURIComponent(request.job_id)}/`, { timeoutMs })).data, this.apiKey);
  }

  async status(input: unknown, timeoutMs?: number): Promise<BuildResult> {
    const request = jobStatusSchema.parse(input);
    const raw = await this.details(request, timeoutMs);
    const base = raw.baseStatus;
    check(base && typeof base.state === 'string', 'DSS response has no baseStatus.state');
    const state = base.state === 'DONE' ? 'SUCCESS' : ['FAILED', 'ABORTED'].includes(base.state) ? base.state : 'RUNNING';
    const outputs = (base.def?.outputs ?? []).map((o: any) => o.targetDataset ?? o.id).filter((v: any) => typeof v === 'string');
    const result: BuildResult = { ...request, dataset_name: outputs.length === 1 ? outputs[0] : '', outputs, state, dss_state: base.state,
      started_at: iso(base.jobStartTime), finished_at: iso(base.jobEndTime) };
    if (state === 'FAILED' || state === 'ABORTED') {
      const failed = Object.entries(base.activities ?? {}).find(([, a]: any) => ['FAILED', 'ABORTED'].includes(a.state));
      const activity: any = failed?.[1];
      const message = activity?.errorMessage ?? activity?.failureMessage ?? base.errorMessage ?? base.failureMessage ?? `DSS job ${base.state}`;
      result.error = { message: typeof message === 'string' ? message : JSON.stringify(message), activity_id: failed?.[0] };
      try {
        const log = await this.log({ ...request, activity_id: failed?.[0] }, timeoutMs);
        result.error.log_excerpt = log.log_excerpt;
      } catch { result.error.log_excerpt = '[Log unavailable; inspect get_job_details for activity diagnostics]'; }
    }
    return sanitize(result, this.apiKey);
  }

  async log(input: unknown, timeoutMs?: number) {
    const request = jobLogSchema.parse(input);
    const suffix = request.activity_id ? `?activity=${encodeURIComponent(request.activity_id)}` : '';
    const raw = (await this.http.getText(`/projects/${request.project_key}/jobs/${encodeURIComponent(request.job_id)}/log${suffix}`, { timeoutMs })).data;
    const safe = sanitize(raw, this.apiKey) as string;
    return { project_key: request.project_key, job_id: request.job_id, activity_id: request.activity_id,
      log_excerpt: safe.slice(-request.max_chars), truncated: safe.length > request.max_chars };
  }

  async wait(input: unknown): Promise<BuildResult> {
    const request = waitForJobSchema.parse(input);
    const deadline = this.clock.now() + request.timeout_seconds * 1000;
    let result: BuildResult | undefined;
    let delay = 250;
    do {
      try { result = await this.status({ project_key: request.project_key, job_id: request.job_id }, Math.max(1, deadline - this.clock.now())); }
      catch (error) {
        // Preserve the last known state and ID without resubmitting or cancelling the job.
        if (this.clock.now() >= deadline) return { ...(result ?? { project_key: request.project_key, job_id: request.job_id,
          dataset_name: '', outputs: [], state: 'RUNNING' as const }), timed_out: true, monitoring_error: sanitize(errorDetails(error), this.apiKey) };
        if (!result) throw error;
        return { ...result, timed_out: this.clock.now() >= deadline, monitoring_error: sanitize(errorDetails(error), this.apiKey) };
      }
      if (result.state !== 'RUNNING') return result;
      const remaining = deadline - this.clock.now();
      if (remaining <= 0) break;
      await this.clock.sleep(Math.min(delay, remaining));
      delay = Math.min(delay * 2, 5000);
    } while (this.clock.now() < deadline);
    return { ...result, timed_out: true };
  }
}
