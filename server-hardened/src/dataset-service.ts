import { FlowZoneService } from './flow-zone.js';
import { randomUUID } from 'node:crypto';
import { createDatasetSchema, type DatasetRequest } from './dataset-config.js';
import { errorDetails } from './dss-error.js';

type ObjectValue = Record<string, any>;
export interface DatasetTransport {
  get(path: string, options?: { params?: Record<string, string>; sample?: { rows: number; width: number } }): Promise<{ data: any }>;
  post(path: string, body?: unknown): Promise<{ data: any }>;
  put(path: string, body?: unknown): Promise<{ data: any }>;
  delete?(path: string): Promise<{ data: any }>;
}
export interface DatasetPlan { request: DatasetRequest; body: ObjectValue; settings: ObjectValue; validation_scope: string; zone: { zone_id: string; zone_name: string } }
export interface DatasetReceipt { path: string; body: ObjectValue; creationTag?: unknown }
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function retains(actual: any, expected: any): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => retains(actual[i], v));
  if (expected && typeof expected === 'object') return actual && typeof actual === 'object' && Object.entries(expected).every(([k, v]) => retains(actual[k], v));
  return actual === expected;
}
function cleanOptions(value: unknown): any {
  if (Array.isArray(value)) return value.map(cleanOptions);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    check(!/secret|password|credential|token|authorization|api.?key|access.?key/i.test(key), `Secret configuration field is not permitted: ${key}`);
    return [key, cleanOptions(entry)];
  }));
  return value;
}
function normalizedPath(path: string) {
  check(!/[\\$?*#%]/.test(path) && ![...path].some(c => c.charCodeAt(0) < 32) && !path.includes('://'), 'Path must be a literal storage path');
  check(!path.split('/').some(p => p === '.' || p === '..'), 'Path traversal is not permitted');
  const result = '/' + path.split('/').filter(Boolean).join('/');
  check(result !== '/', 'Storage root cannot be used as a dataset path');
  return result;
}
function existingPath(dataset: ObjectValue, ownerProject: string): string {
  check(typeof ownerProject === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(ownerProject), 'Existing dataset has an invalid owning project');
  check(typeof dataset.params.path === 'string', 'Existing dataset storage path is invalid');
  // Only DSS's known project placeholder is resolved, only for existing metadata.
  // Never expand request paths or evaluate arbitrary project/environment variables.
  const resolved = dataset.params.path.split('${projectKey}').join(ownerProject);
  check(!resolved.includes('$'), `Unresolved variable in existing dataset path (${ownerProject}.${dataset.name ?? 'unknown'}); cannot establish storage overlap safely`);
  return normalizedPath(resolved);
}
export function overlappingStorage(a: ObjectValue, b: ObjectValue, existingOwner?: string): boolean {
  if (a.type !== b.type || !a.params?.path || !b.params?.path) return false;
  if (a.type === 'S3' && a.params.bucket !== b.params.bucket) return false;
  // Treat connection aliases conservatively. Filesystem case differences may alias on Windows.
  const path = (v: ObjectValue, owner?: string) => {
    const p = owner === undefined ? normalizedPath(v.params.path) : existingPath(v, owner);
    return a.type === 'Filesystem' ? p.toLowerCase() : p;
  };
  const x = path(a), y = path(b, existingOwner);
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
}
function references(recipe: ObjectValue, name: string) {
  return [recipe.inputs, recipe.outputs].some(roles => Object.values(roles ?? {}).some(role =>
    ((role as ObjectValue).items ?? []).some((item: ObjectValue) => item.ref === name || item.ref?.endsWith('.' + name))));
}
export class DatasetService {
  constructor(private readonly http: DatasetTransport) {}

  async plan(input: unknown): Promise<DatasetPlan> {
    const request = createDatasetSchema.parse(input);
    const zone = await new FlowZoneService(this.http).resolve(request.project_key, request);
    const root = `/projects/${request.project_key}`;
    await this.http.get(root);
    const local = (await this.http.get(`${root}/datasets/`)).data as ObjectValue[];
    check(!local.some(d => d.name === request.dataset_name), `Dataset name conflict: ${request.dataset_name}`);
    check(request.path, 'A new explicit path is required for output provisioning');
    const path = normalizedPath(request.path);
    let source: ObjectValue = {};
    if (request.clone_settings_from) {
      check(local.some(d => d.name === request.clone_settings_from), `Missing source dataset: ${request.clone_settings_from}`);
      source = (await this.http.get(`${root}/datasets/${request.clone_settings_from}`)).data;
    }
    const type = request.dataset_type ?? source.type;
    check(type === 'S3' || type === 'Filesystem', 'Only managed S3 and Filesystem provisioning is supported');
    check(!source.type || source.type === type, 'Clone dataset type cannot be changed');
    check(request.managed !== false, 'Only managed dataset provisioning is supported');
    const connection = request.connection ?? source.params?.connection;
    check(connection, 'Storage connection is required');
    const connections = (await this.http.get('/connections/get-names?type=all')).data;
    check(Array.isArray(connections) && connections.includes(connection), `Invalid or inaccessible connection: ${connection}`);
    const params: ObjectValue = { connection, path };
    if (type === 'S3') {
      params.bucket = request.bucket ?? source.params?.bucket;
      check(typeof params.bucket === 'string' && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(params.bucket), 'A valid S3 bucket is required');
    } else check(!request.bucket, 'Filesystem datasets cannot specify a bucket');
    // Never copy table identities, explicit file lists, variables or credentials from source.
    if (source.params?.notReadyIfEmpty !== undefined) params.notReadyIfEmpty = source.params.notReadyIfEmpty;
    const formatType = request.format_type ?? source.formatType;
    check(formatType, 'format_type is required without a clone source');
    const schema = cleanOptions(request.schema ?? source.schema ?? { columns: [] });
    check(Array.isArray(schema.columns), 'Schema must contain a columns array');
    check(new Set(schema.columns.map((c: ObjectValue) => c.name)).size === schema.columns.length, 'Schema column names must be unique');
    const body = { projectKey: request.project_key, name: request.dataset_name, type, managed: true, params,
      formatType, formatParams: cleanOptions(request.format_params ?? source.formatParams ?? {}), schema };
    check(!source.params?.path || !overlappingStorage(body, source, source.projectKey ?? request.project_key), 'Storage path conflicts with clone source');
    const settings: ObjectValue = {};
    for (const key of ['partitioning', 'readWriteOptions']) if (source[key] !== undefined) settings[key] = cleanOptions(source[key]);
    // Inspect all visible projects, failing closed if any accessible inventory cannot be read.
    const projects = (await this.http.get('/projects/')).data as ObjectValue[];
    const keys = new Set([request.project_key, ...projects.map(p => p.projectKey ?? p.key)]);
    for (const key of keys) {
      check(typeof key === 'string' && /^[A-Za-z0-9_.-]+$/.test(key), 'Invalid project inventory response');
      const inventory = key === request.project_key ? local : (await this.http.get(`/projects/${key}/datasets/`)).data;
      for (let dataset of inventory) {
        if (!['S3', 'Filesystem'].includes(dataset.type)) continue;
        if (!dataset.params) dataset = (await this.http.get(`/projects/${key}/datasets/${encodeURIComponent(dataset.name)}`)).data;
        check(!overlappingStorage(body, dataset, dataset.projectKey ?? key), `Storage path conflict with dataset ${key}.${dataset.name}`);
      }
    }
    return { request, body, settings, zone, validation_scope: 'All visible project inventories; hidden projects and unregistered storage objects cannot be inspected. No storage or DSS engine execution.' };
  }

  async provision(plan: DatasetPlan, receipts: DatasetReceipt[]) {
    check(!plan.request.dry_run, 'Dry-run plans cannot be provisioned');
    // Revalidate immediately before POST, including storage/name conflicts. DSS has no atomic reserve API.
    const fresh = await this.plan(plan.request);
    check(JSON.stringify(fresh.body) === JSON.stringify(plan.body) && JSON.stringify(fresh.settings) === JSON.stringify(plan.settings), 'Source settings changed after preflight; retry');
    const root = `/projects/${plan.request.project_key}/datasets/`;
    await this.http.post(root, plan.body);
    const receipt: DatasetReceipt = { path: root + plan.request.dataset_name, body: plan.body };
    receipts.push(receipt);
    const created = (await this.http.get(receipt.path)).data;
    check(created.name === plan.body.name && created.type === plan.body.type && retains(created.params, plan.body.params), 'Created dataset differs from request');
    receipt.creationTag = created.creationTag;
    const desired = { managed: true, schema: plan.body.schema, ...plan.settings };
    if (Object.entries(desired).some(([k, v]) => !retains(created[k], v))) {
      await this.http.put(receipt.path, { ...created, ...desired });
    }
    const result = (await this.http.get(receipt.path)).data;
    for (const [k, v] of Object.entries({ ...desired, params: plan.body.params, type: plan.body.type, formatType: plan.body.formatType, formatParams: plan.body.formatParams })) {
      check(retains(result[k], v), `DSS did not retain requested ${k}`);
    }
    return { name: result.name, type: result.type, managed: result.managed, schema: result.schema, executed: false };
  }

  async rollback(receipts: DatasetReceipt[]) {
    const results: ObjectValue[] = [];
    for (const receipt of [...receipts].reverse()) {
      try {
        check(this.http.delete && receipt.creationTag, 'No confirmed creation identity or DELETE transport; retained');
        const inspect = async () => {
          const current = (await this.http.get(receipt.path)).data;
          check(JSON.stringify(current.creationTag) === JSON.stringify(receipt.creationTag), 'Creation identity changed; retained');
          check(current.params?.path === receipt.body.params.path && current.params?.connection === receipt.body.params.connection && current.params?.bucket === receipt.body.params.bucket, 'Storage identity changed; retained');
          check(!(current.partitioning?.dimensions?.length), 'Partitioned dataset emptiness cannot be proven; retained');
          const projects = (await this.http.get('/projects/')).data;
          for (const p of projects) {
            const recipes = (await this.http.get(`/projects/${p.projectKey ?? p.key}/recipes/`)).data;
            check(!recipes.some((r: ObjectValue) => references(r, receipt.body.name)), 'Dataset has recipe references; retained');
          }
          return current;
        };
        const before = await inspect();
        check(Array.isArray(before.schema?.columns) && before.schema.columns.length > 0, 'No readable schema to prove emptiness; retained');
        const readSessionId = randomUUID();
        const rows = (await this.http.get(`${receipt.path}/data/`, { params: { format: 'tsv-excel-noheader', readSessionId },
          sample: { rows: 1, width: before.schema.columns.length } })).data;
        check(rows?.complete === true && Array.isArray(rows.rows) && rows.rows.length === 0, 'Dataset is nonempty or emptiness is unknown; retained');
        await this.http.get(`${receipt.path}/finish-streaming/`, { params: { readSessionId } });
        const after = await inspect();
        check(JSON.stringify(before.versionTag) === JSON.stringify(after.versionTag), 'Dataset version changed; retained');
        // Remove only DSS metadata. Never delete physical storage, even after an empty read.
        await this.http.delete!(`${receipt.path}?dropData=false`);
        results.push({ dataset: receipt.body.name, rolled_back: true, data_deleted: false });
      } catch (error) { results.push({ dataset: receipt.body.name, rolled_back: false, reason: error instanceof Error ? error.message : 'Unable to prove safe rollback' }); }
    }
    return results;
  }

  async create(input: unknown) {
    const plan = await this.plan(input);
    if (plan.request.dry_run) return { dry_run: true, writes: 0, creation_request: plan.body, post_create_settings: plan.settings, proposed_zone_assignment: plan.zone, validation_scope: plan.validation_scope };
    const receipts: DatasetReceipt[] = [];
    try {
      const result = await this.provision(plan, receipts);
      const zones = new FlowZoneService(this.http);
      if (plan.request.zone_id || plan.request.zone_name) await zones.move({ project_key: plan.request.project_key, target_zone_id: plan.zone.zone_id,
        items: [{ object_type: 'dataset', object_id: plan.request.dataset_name }], dry_run: false });
      const assigned_zone = await zones.object({ project_key: plan.request.project_key, object_type: 'dataset', object_id: plan.request.dataset_name });
      check(!(plan.request.zone_id || plan.request.zone_name) || assigned_zone.zone_id === plan.zone.zone_id, 'Created dataset zone read-back mismatch');
      return { ...result, assigned_zone };
    }
    catch (error) { throw new Error(JSON.stringify({ error: 'Dataset provisioning failed', cause: errorDetails(error), rollback: await this.rollback(receipts), note: 'If POST outcome is unknown, inspect DSS before retrying; unconfirmed resources are never deleted.' })); }
  }
}
