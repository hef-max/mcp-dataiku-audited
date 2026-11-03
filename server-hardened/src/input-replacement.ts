import { z } from 'zod';
import { validateJoinSchemas } from './join-effective-schema.js';
import { isDeepStrictEqual as equal } from 'node:util';
import { assert, parsePayload } from './recipe-config.js';
import type { RecipeTransport } from './recipe-service.js';
import { sanitize, errorDetails } from './dss-error.js';
import { hasRetiredReference, retiredInputReferences } from './recipe-references.js';

const id = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/);
export const replaceInputSchema = z.strictObject({ project_key: id, recipe_name: id, old_input: id, new_input: id,
  require_identical_schema: z.literal(true).default(true), dry_run: z.boolean().default(true) });
type Obj = Record<string, any>;
function slots(recipe: Obj) {
  const result: { role: string; index: number; ref: string }[] = [];
  for (const [role, group] of Object.entries(recipe.inputs ?? {}) as [string, Obj][]) {
    assert(Array.isArray(group.items), 'Invalid recipe input role');
    group.items.forEach((item: Obj, index: number) => { assert(typeof item.ref === 'string', 'Invalid input ref'); result.push({ role, index, ref: item.ref }); });
  }
  return result;
}
function canonicalSchema(schema: Obj) {
  assert(Array.isArray(schema?.columns) && schema.columns.length, 'Empty or invalid input schema');
  const columns = schema.columns.map((c: Obj) => {
    assert(typeof c.name === 'string' && typeof c.type === 'string', 'Invalid input column');
    return { name: c.name, type: c.type, meaning: c.meaning ?? null };
  });
  assert(new Set(columns.map((c: Obj) => c.name)).size === columns.length, 'Duplicate input schema columns');
  return columns;
}
function verifyEnvelope(actual: Obj, proposed: Obj) {
  assert(actual?.recipe, 'Empty recipe read-back');
  // DSS updates versionTag when saving. All other metadata and native payload
  // must remain structure-equivalent; do not hide mapping/UI/filter changes.
  const stable = (r: Obj) => Object.fromEntries(Object.entries(r).filter(([key]) => key !== 'versionTag'));
  assert(equal(stable(actual.recipe), stable(proposed.recipe)), 'Replacement metadata read-back mismatch');
  assert(equal(parsePayload(actual as any), parsePayload(proposed as any)), 'Replacement native configuration read-back mismatch');
}

/** One recipe settings PUT, no provisioning/schema writes/builds or typed REMAP reconstruction. */
export class InputReplacementService {
  constructor(private readonly http: RecipeTransport, private readonly apiKey = '') {}
  async replace(input: unknown) {
    const r = replaceInputSchema.parse(input), root = `/projects/${r.project_key}`;
    const local = (name: string) => name.startsWith(r.project_key + '.') ? name.slice(r.project_key.length + 1) : name;
    const oldName = local(r.old_input), newName = local(r.new_input);
    assert(oldName !== newName, 'Old and new input must differ');
    await this.http.get(root);
    const path = `${root}/recipes/${r.recipe_name}`;
    const before = (await this.http.get(path)).data;
    assert(before?.recipe && typeof before.recipe.type === 'string', 'Recipe is unavailable or invalid');
    const type = before.recipe.type;
    assert(['vstack', 'join', 'shaker', 'grouping', 'window', 'distinct'].includes(type), 'Unsupported visual recipe adapter');
    const originalSlots = slots(before.recipe), matches = originalSlots.filter(s => local(s.ref) === oldName);
    assert(matches.length === 1, 'Old input must occur exactly once');
    assert(!originalSlots.some(s => local(s.ref) === newName), 'New input is already used by this recipe');
    const slot = matches[0];
    const outputs = Object.values(before.recipe.outputs ?? {}).flatMap((v: any) => v.items ?? []);
    assert(!outputs.some((v: any) => local(v.ref) === newName), 'New input cannot be a recipe output');
    const inventory = (await this.http.get(`${root}/datasets/`)).data;
    assert(Array.isArray(inventory), 'Invalid dataset inventory');
    for (const name of [oldName, newName]) assert(inventory.some(d => d.name === name), `Dataset unavailable: ${name}`);
    const oldSchema = canonicalSchema((await this.http.get(`${root}/datasets/${oldName}/schema`)).data);
    const newSchema = canonicalSchema((await this.http.get(`${root}/datasets/${newName}/schema`)).data);
    assert(equal(oldSchema, newSchema), 'Input schema mismatch: names, order, types and meanings must be identical');
    const proposed = structuredClone(before), payload = structuredClone(parsePayload(before));
    const changes: Obj[] = [];
    let effectiveSchemas: Obj[] | undefined;
    const renamed = (value: string) => value === oldName ? newName : value === `${r.project_key}.${oldName}` ? `${r.project_key}.${newName}` : value;
    const setRef = (obj: Obj, key: string, location: string) => {
      if (typeof obj[key] !== 'string') return;
      const next = renamed(obj[key]);
      if (next !== obj[key]) { changes.push({ path: location + '.' + key, before: obj[key], after: next }); obj[key] = next; }
    };
    const engineReferences = (value: any, location: string, keysOnly = false): any => {
      if (typeof value === 'string') {
        const next = keysOnly ? value : renamed(value);
        if (next !== value) changes.push({ path: location, before: value, after: next });
        return next;
      }
      if (Array.isArray(value)) return value.map((v, i) => engineReferences(v, `${location}[${i}]`, keysOnly));
      if (!value || typeof value !== 'object') return value;
      const entries = Object.entries(value).map(([key, v]) => {
        const next = renamed(key);
        assert(next === key || !Object.prototype.hasOwnProperty.call(value, next), 'Dataset reference key collision');
        if (next !== key) changes.push({ path: location, before_key: key, after_key: next });
        return [next, engineReferences(v, `${location}.${next}`, keysOnly)];
      });
      return Object.fromEntries(entries);
    };
    setRef(proposed.recipe.inputs[slot.role].items[slot.index], 'ref', `recipe.inputs.${slot.role}.items[${slot.index}]`);
    if (type === 'vstack' || type === 'join') {
      assert(originalSlots.every(s => s.role === 'main'), 'Virtual input adapter supports main input role only');
      assert(Array.isArray(payload.virtualInputs) && payload.virtualInputs.length === originalSlots.length, 'Virtual input slots do not match metadata');
      const virtual = payload.virtualInputs as Obj[];
      virtual.forEach((v, index) => assert(v.index === index, 'Ambiguous virtual input index'));
      const v = virtual[slot.index];
      assert(typeof v.originLabel === 'string' && local(v.originLabel) === oldName, 'Virtual input originLabel does not match old input slot');
      for (const key of ['originLabel', 'alias', 'label', 'dataset', 'datasetName', 'inputDataset', 'ref']) setRef(v, key, `payload.virtualInputs[${slot.index}]`);
      if (type === 'join') {
        assert(Array.isArray(payload.joins) && Array.isArray(payload.selectedColumns), 'Invalid native Join payload');
        const physical = [];
        for (const [index, input] of originalSlots.entries()) physical.push(index === slot.index ? newSchema :
          canonicalSchema((await this.http.get(`${root}/datasets/${local(input.ref)}/schema`)).data));
        // Validate before renaming aliases: expressions remain entirely unchanged.
        const originalPayload = parsePayload(before);
        effectiveSchemas = validateJoinSchemas(r.recipe_name, originalPayload, physical);
      }
    } else assert(originalSlots.length === 1, 'Single-input adapter requires exactly one input');
    const rewriteSettings = (settings: Obj, location: string) => {
      for (const key of ['copySchemaFromDatasetWithName', 'inputDataset', 'inputDatasetName', 'datasetName']) setRef(settings, key, location);
      for (const key of ['engineParams', 'readParams', 'readSettings', 'cacheSettings']) {
        if (settings[key] !== undefined) settings[key] = engineReferences(settings[key], `${location}.${key}`);
      }
      for (const key of ['columnMappings', 'columnMapping', 'column_mapping']) {
        if (settings[key] !== undefined) settings[key] = engineReferences(settings[key], `${location}.${key}`, true);
      }
    };
    rewriteSettings(payload, 'payload');
    if (proposed.recipe.params) rewriteSettings(proposed.recipe.params, 'recipe.params');
    const retired = retiredInputReferences([oldName], [newName], r.project_key);
    const noStale = (p: Obj, recipe: Obj) => assert(!hasRetiredReference(p, retired) && !hasRetiredReference(recipe.params, retired) &&
      !slots(recipe).some(s => local(s.ref) === oldName), 'Unsupported or stale old-input reference remains; no generic text substitution is permitted');
    noStale(payload, proposed.recipe);
    proposed.payload = equal(payload, parsePayload(before)) ? before.payload : JSON.stringify(payload);
    const result = { project_key: r.project_key, recipe_name: r.recipe_name, recipe_type: type, old_input: r.old_input, new_input: r.new_input,
      slot: { role: slot.role, index: slot.index, position: slot.index + 1 },
      schema_comparison: { identical: true, compared_fields: ['name', 'type', 'meaning'], order_compared: true, old: oldSchema, new: newSchema },
      native_references_updated: changes, diff: changes, proposed: { recipe: proposed.recipe, payload },
      effective_schemas: effectiveSchemas, expression_validation: 'Native typed references, SQL identifiers and formula val() references; not a DSS engine compilation',
      executed: false, dry_run: r.dry_run, writes: 0, read_back_verification: { performed: false, verified: false } };
    if (r.dry_run) return sanitize(result, this.apiKey);
    // Detect concurrent edits before the single PUT. DSS offers no compare-and-swap.
    const fresh = (await this.http.get(path)).data;
    assert(equal(fresh, before), 'Recipe changed during preflight; no write performed');
    for (const [name, expected] of [[oldName, oldSchema], [newName, newSchema]] as const) {
      assert(equal(canonicalSchema((await this.http.get(`${root}/datasets/${name}/schema`)).data), expected), 'Input schema changed during preflight; no write performed');
    }
    let putConfirmed = false;
    try {
      await this.http.put(path, proposed); putConfirmed = true;
      const actual = (await this.http.get(path)).data;
      verifyEnvelope(actual, proposed); noStale(parsePayload(actual), actual.recipe);
      return sanitize({ ...result, writes: 1, read_back_verification: { performed: true, verified: true } }, this.apiKey);
    } catch (error) {
      let rollback: Obj;
      try {
        await this.http.put(path, before);
        verifyEnvelope((await this.http.get(path)).data, before);
        rollback = { attempted: true, verified: true };
      } catch (failure) { rollback = { attempted: true, verified: false, error: errorDetails(failure) }; }
      throw new Error(JSON.stringify(sanitize({ error: 'Input replacement save or read-back failed', cause: errorDetails(error),
        write_attempted: true, put_confirmed: putConfirmed, write_attempts: 2, writes: null, dry_run: false,
        rollback, read_back_verification: { verified: false }, executed: false, recovery: 'Rollback attempted and read back; inspect rollback.verified before retrying. No build.' }, this.apiKey)));
    }
  }
}
