import { isDeepStrictEqual } from 'node:util';
import { updateDatasetSchema } from './dataset-config.js';
import { errorDetails } from './dss-error.js';
type JsonObject = Record<string, any>;
interface Transport { get(path: string): Promise<{ data: any }>; put(path: string, body: unknown): Promise<{ data: any }> }
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export function schemaMatches(actual: any, requested: any): boolean {
  return Array.isArray(actual?.columns) && actual.columns.length === requested.columns.length && requested.columns.every((column: JsonObject, i: number) =>
    Object.entries(column).every(([k, v]) => isDeepStrictEqual(actual.columns[i]?.[k], v)));
}
function protectedSettings(settings: JsonObject) {
  // DSS may update schema-system version and derived display name along with the schema.
  // These are bookkeeping; storage, metrics and user metadata remain protected below.
  const { schema: _schema, versionTag: _version, typeSystemVersion: _typeVersion, smartName: _display, ...rest } = settings;
  void _schema; void _version; void _typeVersion; void _display;
  return rest;
}
function diff(before: any, after: any) {
  const old = before.columns ?? [], next = after.columns;
  return { added: next.filter((c: JsonObject) => !old.some((o: JsonObject) => o.name === c.name)),
    removed: old.filter((c: JsonObject) => !next.some((n: JsonObject) => n.name === c.name)),
    changed: next.flatMap((c: JsonObject) => { const o = old.find((item: JsonObject) => item.name === c.name);
      return o && Object.entries(c).some(([k, v]) => !isDeepStrictEqual(o[k], v)) ? [{ before: o, after: c }] : []; }),
    order_changed: !isDeepStrictEqual(old.map((c: JsonObject) => c.name), next.map((c: JsonObject) => c.name)) };
}
/** A schema-only PUT follows official DSSDataset.set_schema; never save stale full dataset settings. */
export class SchemaService {
  constructor(private readonly http: Transport) {}
  async update(input: unknown) {
    const request = updateDatasetSchema.parse(input);
    const root = `/projects/${request.project_key}`;
    const path = `${root}/datasets/${request.dataset_name}`;
    await this.http.get(root);
    const before = (await this.http.get(path)).data;
    check(before && typeof before.schema === 'object', 'Dataset settings contain no schema');
    const desired = request.schema ? { ...before.schema, columns: request.schema.columns } : before.schema;
    const changed = request.schema !== undefined && !schemaMatches(before.schema, request.schema);
    const result = { project_key: request.project_key, dataset_name: request.dataset_name,
      schema_before: before.schema, schema_after: desired, diff: diff(before.schema, desired), changed,
      dry_run: request.dry_run, writes: 0, executed: false, data_deleted: false };
    if (request.dry_run || !changed) return { ...result, verified: !request.dry_run, storage_settings_preserved: true };
    // Avoid overwriting an intervening schema/config change. DSS offers no atomic compare-and-swap here.
    const fresh = (await this.http.get(path)).data;
    check(isDeepStrictEqual(before, fresh), 'Dataset settings changed during preflight; no schema was written, retry after inspection');
    let putConfirmed = false;
    try {
      await this.http.put(`${path}/schema`, desired);
      putConfirmed = true;
      const readback = (await this.http.get(`${path}/schema`)).data;
      const after = (await this.http.get(path)).data;
      check(schemaMatches(readback, desired) && schemaMatches(after.schema, desired), `Schema read-back mismatch: ${JSON.stringify({ requested: desired, actual: readback })}`);
      const previous = protectedSettings(before), current = protectedSettings(after);
      const changedKeys = [...new Set([...Object.keys(previous), ...Object.keys(current)])].filter(k => !isDeepStrictEqual(previous[k], current[k]));
      check(!changedKeys.length, `Protected settings changed during schema update: ${changedKeys.join(', ')}; inspect dataset`);
      return { ...result, schema_after: readback, writes: 1, verified: true, storage_settings_preserved: true };
    } catch (error) {
      // Never delete data/resources or blindly restore a stale schema after an ambiguous PUT.
      throw new Error(JSON.stringify({ error: 'Schema application or verification failed', project_key: request.project_key,
        dataset_name: request.dataset_name, cause: errorDetails(error), requested_schema: desired, previous_schema: before.schema,
        put_confirmed: putConfirmed, rollback: 'No destructive or automatic schema rollback; inspect current schema before retrying', executed: false, data_deleted: false }));
    }
  }
}
