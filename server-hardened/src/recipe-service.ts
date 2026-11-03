import { FlowZoneService } from './flow-zone.js';
import { retiredInputReferences, resetInputSettings, assertNoRetiredReferences } from './recipe-references.js';
import {
  assert, buildVisualPayload, canonicalType, createRecipeSchema, parsePayload, recipeInfo,
  updateRecipeSchema, repairRecipeSchema, inspectPayload, validateRequest,
  type ResolvedCreateRecipeRequest, type NativeObject, type RecipeEnvelope, type Schemas,
} from './recipe-config.js';
import { DatasetService, overlappingStorage, type DatasetPlan, type DatasetReceipt } from './dataset-service.js';
import { errorDetails } from './dss-error.js';
import { buildWindow, verifyWindow } from './window-config.js';
import { SchemaService } from './schema-service.js';
import { isDeepStrictEqual } from 'node:util';

export interface RecipeTransport {
  get(path: string): Promise<{ data: any }>;
  post(path: string, body?: unknown): Promise<{ data: any }>;
  put(path: string, body?: unknown): Promise<{ data: any }>;
  delete?(path: string): Promise<{ data: any }>;
}
type Role = { items?: { ref: string; [key: string]: unknown }[] };
function refs(roles: unknown): string[] {
  return Object.values((roles ?? {}) as Record<string, Role>).flatMap(r => (r.items ?? []).map(i => i.ref));
}
function sameSchema(a: unknown, b: unknown) { return isDeepStrictEqual(a, b); }
function verifyRecipe(envelope: RecipeEnvelope, request: ResolvedCreateRecipeRequest, patch?: NativeObject) {
  assert(envelope?.recipe && envelope.recipe.type === canonicalType(request.recipe_type), 'Recipe type read-back mismatch');
  assert(sameSchema(refs(envelope.recipe.inputs), request.inputs), 'Recipe input read-back mismatch');
  assert(sameSchema(refs(envelope.recipe.outputs), request.outputs.map(o => o.name)), 'Recipe output read-back mismatch');
  if (request.config?.kind === 'join' && patch) {
    const actual = parsePayload(envelope) as any, expected = patch as any;
    const select = (p: any) => p.selectedColumns?.map((c: any) => ({ table: c.table, name: c.name, alias: c.alias || c.name }));
    const joins = (p: any) => p.joins?.map((j: any) => ({ type: j.type, table1: j.table1, table2: j.table2,
      conditionsMode: j.conditionsMode, on: j.on?.map((k: any) => ({ type: k.type,
        column1: { table: k.column1?.table, name: k.column1?.name }, column2: { table: k.column2?.table, name: k.column2?.name } })) }));
    assert(sameSchema(joins(actual), joins(expected)), 'Join type/keys read-back mismatch');
    assert(sameSchema(select(actual), select(expected)), 'Join selected columns/aliases read-back mismatch');
    assert(actual.joins.every((j: any) => j.on?.length > 0 && j.rightLimit?.enabled === false), 'Join must have keys and no right-side row limit');
    assert(actual.virtualInputs?.length === request.inputs.length && actual.virtualInputs.every((v: any, i: number) =>
      v.index === i && v.originLabel === request.inputs[i] && v.alias === request.inputs[i] && v.outputColumnsSelectionMode === 'MANUAL' && v.preFilter?.enabled === false && !v.computedColumns?.length), 'Join virtual input read-back mismatch');
    assert(actual.postFilter?.enabled === expected.postFilter.enabled && (!expected.postFilter.enabled || actual.postFilter.expression === expected.postFilter.expression), 'Join post-filter read-back mismatch');
  } else if (request.config?.kind === 'window' && !request.config.template && patch) {
    verifyWindow(parsePayload(envelope), patch);
  } else if (request.config && patch) {
    const actual = parsePayload(envelope);
    // DSS may add UI bookkeeping, but every requested semantic field must survive.
    verifyConfiguration(actual, patch);
  }
}

function verifyConfiguration(actual: any, expected: any, path = 'configuration'): void {
  if (Array.isArray(expected)) {
    assert(Array.isArray(actual) && actual.length === expected.length, `Visual read-back mismatch: ${path}`);
    expected.forEach((value, index) => verifyConfiguration(actual[index], value, `${path}[${index}]`));
  } else if (expected && typeof expected === 'object') {
    assert(actual && typeof actual === 'object', `Visual read-back mismatch: ${path}`);
    for (const [key, value] of Object.entries(expected)) {
      if (!key.startsWith('$') && !['preview', 'alwaysShowComment'].includes(key)) verifyConfiguration(actual[key], value, `${path}.${key}`);
    }
  } else assert(sameSchema(actual, expected), `Visual read-back mismatch: ${path}`);
}
function composePayload(envelope: RecipeEnvelope, patch: NativeObject, explicitWindow: boolean, resetInputs = false) {
  const old = inspectPayload(envelope).config;
  return JSON.stringify({ ...(!explicitWindow && !resetInputs && old?.engineParams ? { engineParams: old.engineParams } : {}), ...patch });
}

/** Provision outputs when explicitly requested; never build or run recipes. */
export class RecipeService {
  constructor(private readonly http: RecipeTransport) {}

  async info(project: string, name: string) {
    const request = updateRecipeSchema.parse({ project_key: project, recipe_name: name });
    return recipeInfo((await this.http.get(`/projects/${request.project_key}/recipes/${request.recipe_name}`)).data);
  }

  private async preflight(request: ResolvedCreateRecipeRequest, updating = false) {
    validateRequest(request);
    const root = `/projects/${request.project_key}`;
    await this.http.get(root);
    const datasets = (await this.http.get(`${root}/datasets/`)).data as { name: string }[];
    const names = new Set(datasets.map(d => d.name));
    for (const input of request.inputs) assert(names.has(input), `Missing input dataset: ${input}`);
    for (const output of request.outputs) {
      assert(!updating || !output.new, 'Output provisioning is supported only by create_recipe');
      if (output.new) assert(!names.has(output.name), `Output name conflict: ${output.name}`);
      else assert(names.has(output.name), `Missing output dataset: ${output.name}; specify new: true with storage settings`);
    }
    const recipes = (await this.http.get(`${root}/recipes/`)).data as NativeObject[];
    if (!updating) assert(!recipes.some(r => r.name === request.recipe_name), `Recipe name conflict: ${request.recipe_name}`);
    for (const r of recipes) {
      if (updating && r.name === request.recipe_name) continue;
      const conflicts = refs(r.outputs).filter(ref => request.outputs.some(o => o.name === ref));
      assert(!conflicts.length, `Output name conflict: ${conflicts.join(', ')} is owned by ${r.name}`);
    }
    const schemas: Schemas = {};
    for (const input of request.inputs) {
      schemas[input] = (await this.http.get(`${root}/datasets/${input}/schema`)).data.columns;
      assert(Array.isArray(schemas[input]) && schemas[input].length, `Input schema is empty: ${input}`);
    }
    const type = canonicalType(request.recipe_type);
    const zone = !updating ? await new FlowZoneService(this.http).resolve(request.project_key, request) : undefined;
    if (!updating && (request.zone_id || request.zone_name) && !request.move_existing_outputs) {
      for (const output of request.outputs.filter(o => !o.new)) {
        const assigned = await new FlowZoneService(this.http).object({ project_key: request.project_key, object_type: 'dataset', object_id: output.name });
        assert(assigned.zone_id === zone!.zone_id, 'Existing output is in a different zone; use explicit move_existing_outputs=true or an output already in target zone');
      }
    }
    let patch: NativeObject | undefined;
    let windowSchema: ReturnType<typeof buildWindow>['schema'] | undefined;
    if (request.config?.kind === 'window' && !request.config.template) {
      const built = buildWindow(request.config, schemas[request.inputs[0]]);
      patch = built.payload; windowSchema = built.schema;
      for (const output of request.outputs) {
        assert(!output.schema || sameSchema(output.schema, windowSchema), 'Explicit output schema conflicts with inferred Window schema');
        if (output.new) output.schema = windowSchema;
      }
    } else if (request.config?.kind === 'window' || request.config?.kind === 'distinct' || request.config?.kind === 'shaker' && request.config.template) {
      const templateName = request.config.template!.recipe_name;
      const template = (await this.http.get(`${root}/recipes/${templateName}`)).data as RecipeEnvelope;
      assert(template?.recipe?.type === type, 'Template recipe type does not match requested type');
      const inputNames = refs(template.recipe.inputs);
      assert(inputNames.length === 1, 'Template must have exactly one input');
      assert(refs(template.recipe.outputs).length === 1, 'Template must have exactly one output');
      const templateColumns = (await this.http.get(`${root}/datasets/${inputNames[0]}/schema`)).data.columns;
      assert(sameSchema(templateColumns.map((c: { name: string; type: string }) => ({ name: c.name, type: c.type })),
        schemas[request.inputs[0]].map(c => ({ name: c.name, type: c.type }))), 'Template input schema must exactly match names, types and order');
      patch = parsePayload(template);
      // Avoid silently carrying physical engine settings bound to another recipe/input.
      delete patch.engineParams;
    } else if (request.config) patch = buildVisualPayload(request, schemas);
    const outputPlans: DatasetPlan[] = [];
    const datasetsService = new DatasetService(this.http);
    for (const output of request.outputs.filter(o => o.new)) {
      const { name, new: _new, ...storage } = output;
      void _new;
      const plan = await datasetsService.plan({ project_key: request.project_key, dataset_name: name, ...storage, dry_run: request.dry_run });
      assert(!outputPlans.some(other => overlappingStorage(other.body, plan.body)), 'New outputs have overlapping storage paths');
      outputPlans.push(plan);
    }
    const schemaPlans = [];
    if (windowSchema) for (const output of request.outputs) {
      if (!output.new) schemaPlans.push(await new SchemaService(this.http).update({ project_key: request.project_key, dataset_name: output.name, schema: windowSchema, dry_run: true }));
      else schemaPlans.push({ dataset_name: output.name, schema_before: { columns: [] }, schema_after: windowSchema,
        diff: { added: windowSchema.columns, removed: [], changed: [], order_changed: true }, dry_run: true, writes: 0 });
    }
    return { root, type, patch, schemas, outputPlans, windowSchema, schemaPlans, zone };
  }

  async create(input: unknown) {
    const request = createRecipeSchema.parse(input);
    const { root, type, patch, schemas, outputPlans, windowSchema, schemaPlans, zone } = await this.preflight(request);
    const creationSettings: NativeObject = {};
    if (type === 'join' || type === 'vstack') {
      // Official VirtualInputsSingleOutputRecipeCreator supplies these separately from recipePrototype.inputs.
      creationSettings.virtualInputs = request.inputs;
      creationSettings.createOutputDataset = false;
      creationSettings.createOutputFolder = false;
    }
    if (request.code) creationSettings.payload = request.code;
    if (request.config?.kind === 'grouping') creationSettings.groupKey = request.config.group_keys[0] ?? schemas[request.inputs[0]][0].name;
    const body = { recipePrototype: { projectKey: request.project_key, name: request.recipe_name, type, params: {},
      inputs: { main: { items: request.inputs.map(ref => ({ ref, deps: [] })) } },
      outputs: { main: { items: request.outputs.map(o => ({ ref: o.name, appendMode: false })) } } }, creationSettings };
    if (request.dry_run) return { dry_run: true, writes: 0, recipe_type: type, creation_request: body,
      proposed_zone_assignment: { ...zone, recipe: request.recipe_name, new_outputs: request.outputs.filter(o => o.new).map(o => o.name),
        existing_outputs_moved: request.move_existing_outputs ? request.outputs.filter(o => !o.new).map(o => o.name) : [] },
      configuration_patch: patch ?? null, schema_applied: false, schema_diff: schemaPlans,
      output_provisioning: outputPlans.map(p => ({ creation_request: p.body, post_create_settings: p.settings, validation_scope: p.validation_scope })),
      limitations: this.limitations(type), validation_scope: 'Structure, references and column schemas; no DSS engine execution' };
    const datasetService = new DatasetService(this.http);
    const receipts: DatasetReceipt[] = [];
    let createdName: string | undefined;
    try {
      for (const plan of outputPlans) await datasetService.provision(plan, receipts);
      const created = (await this.http.post(`${root}/recipes/`, body)).data as { name?: string } | string | null;
      const returnedName = typeof created === 'string' ? created.trim() : created?.name;
      assert(!returnedName || returnedName === request.recipe_name, 'DSS returned an unexpected recipe name; inspect before retrying');
      createdName = request.recipe_name;
      const path = `${root}/recipes/${encodeURIComponent(createdName)}`;
      const envelope = (await this.http.get(path)).data as RecipeEnvelope;
      assert(envelope?.recipe, 'Recipe creation read-back has no metadata; inspect before retrying');
      assert(envelope.recipe.type === type, 'Created recipe has unexpected type');
      if (patch) {
        assert(sameSchema(refs(envelope.recipe.inputs), request.inputs), 'Created recipe has unexpected inputs; repair with explicit inputs before building');
        envelope.payload = composePayload(envelope, patch, !!windowSchema);
        await this.http.put(path, envelope);
      }
      const configured = (await this.http.get(path)).data as RecipeEnvelope;
      verifyRecipe(configured, request, patch);
      const applied: string[] = [];
      if (windowSchema) for (const output of request.outputs) {
        await new SchemaService(this.http).update({ project_key: request.project_key, dataset_name: output.name, schema: windowSchema });
        applied.push(output.name);
      }
      for (const plan of outputPlans) {
        // Recipe creation can reset output schema. Reapply only explicitly requested columns after configuration.
        if (plan.request.schema && !windowSchema) {
          await new SchemaService(this.http).update({ project_key: request.project_key, dataset_name: plan.request.dataset_name, schema: plan.request.schema });
          applied.push(plan.request.dataset_name);
        }
      }
      const final = (await this.http.get(path)).data as RecipeEnvelope;
      verifyRecipe(final, request, patch);
      const zoneService = new FlowZoneService(this.http);
      const zoneItems = [{ object_type: 'recipe', object_id: request.recipe_name }, ...request.outputs.filter(o => o.new || request.move_existing_outputs).map(o => ({ object_type: 'dataset', object_id: o.name }))];
      if (request.zone_id || request.zone_name) await zoneService.move({ project_key: request.project_key, target_zone_id: zone!.zone_id, items: zoneItems, dry_run: false });
      const assigned_zones = [];
      for (const item of zoneItems) {
        const assigned = await zoneService.object({ project_key: request.project_key, ...item });
        assert(!(request.zone_id || request.zone_name) || assigned.zone_id === zone!.zone_id, 'Created object zone read-back mismatch');
        assigned_zones.push(assigned);
      }
      return { ...recipeInfo(final), assigned_zones, schema_applied: request.outputs.every(o => applied.includes(o.name)),
        provisioned_outputs: receipts.map(r => ({ name: r.body.name, schema_applied: applied.includes(r.body.name) })), executed: false, limitations: this.limitations(type) };
    } catch (error) {
      throw new Error(JSON.stringify({ error: createdName ? `Recipe ${createdName} was created but configuration/read-back failed` : 'Recipe creation failed', cause: errorDetails(error),
        recipe_retained: !!createdName, retention_reason: 'New recipe may own outputs or be in use; automatic deletion safety is not established. Inspect partial creation.', partial_creation: !!createdName, recipe_name: createdName ?? request.recipe_name,
        recovery: 'Inspect get_recipe_info. Use repair_recipe_configuration with complete typed config if I/O is intact; otherwise update_recipe with explicit intended inputs/outputs. Never resubmit create blindly.',
        rollback: await datasetService.rollback(receipts), executed: false,
        note: 'Unconfirmed creations are never deleted. Inspect DSS before retrying an ambiguous response.' }));
    }
  }

  async update(input: unknown, inferJoinInputs = true) {
    const update = updateRecipeSchema.parse(input);
    assert(update.config !== undefined || update.code !== undefined || update.inputs !== undefined || update.outputs !== undefined,
      'Update requires config, code, inputs or outputs');
    const path = `/projects/${update.project_key}/recipes/${update.recipe_name}`;
    const envelope = (await this.http.get(path)).data as RecipeEnvelope;
    assert(envelope?.recipe && typeof envelope.recipe.type === 'string', 'DSS recipe response is empty or invalid (missing recipe metadata)');
    const type = canonicalType(String(envelope.recipe.type));
    assert(!update.recipe_type || canonicalType(update.recipe_type) === type, 'Changing recipe type is not supported');
    const visual = ['join', 'shaker', 'vstack', 'grouping', 'window', 'distinct', 'prompt'].includes(type);
    // Rewiring visual recipes without a full replacement config could invalidate hidden references.
    assert(!visual || update.config, 'Updating a visual recipe requires a complete config; partial raw payload updates are unsupported');
    const previousInputs = refs(envelope.recipe.inputs);
    const joinInputs = inferJoinInputs && update.config?.kind === 'join' ? [update.config.left, update.config.right] : undefined;
    const inferredInputs = joinInputs && !joinInputs.every(i => previousInputs.includes(i)) ? joinInputs : previousInputs;
    const request = createRecipeSchema.parse({ ...update, recipe_type: type,
      inputs: update.inputs ?? inferredInputs,
      outputs: update.outputs ?? refs(envelope.recipe.outputs).map(name => ({ name })),
      code: visual ? update.code : update.code ?? envelope.payload });
    const { patch, windowSchema, schemaPlans } = await this.preflight(request, true);
    const inputsChanged = visual && !sameSchema(previousInputs, request.inputs);
    const retired = retiredInputReferences(previousInputs, request.inputs, request.project_key);
    if (inputsChanged) envelope.recipe.params = resetInputSettings(envelope.recipe.params, retired);
    const roles = (value: unknown) => Object.keys((value ?? {}) as object);
    assert(roles(envelope.recipe.inputs).every(r => r === 'main') && roles(envelope.recipe.outputs).every(r => r === 'main'),
      'Updating recipes with non-main I/O roles is unsupported');
    envelope.recipe.inputs = { main: { items: request.inputs.map(ref => {
      const previous = (envelope.recipe.inputs as Record<string, Role>)?.main?.items?.find(i => i.ref === ref);
      return previous ?? { ref, deps: [] };
    }) } };
    envelope.recipe.outputs = { main: { items: request.outputs.map(o => {
      const previous = (envelope.recipe.outputs as Record<string, Role>)?.main?.items?.find(i => i.ref === o.name);
      return previous ?? { ref: o.name, appendMode: false };
    }) } };
    if (patch) envelope.payload = composePayload(envelope, patch, !!windowSchema, inputsChanged);
    else envelope.payload = request.code!;
    if (visual) assertNoRetiredReferences(parsePayload(envelope), envelope.recipe.params, retired);
    if (update.dry_run) return { dry_run: true, writes: 0, proposed: recipeInfo(envelope), schema_diff: schemaPlans, input_settings_reset: inputsChanged, schema_applied: false, limitations: this.limitations(type) };
    await this.http.put(path, envelope);
    const final = (await this.http.get(path)).data as RecipeEnvelope;
    verifyRecipe(final, request, patch);
    if (visual) assertNoRetiredReferences(parsePayload(final), final.recipe.params, retired);
    if (windowSchema) for (const output of request.outputs) {
      await new SchemaService(this.http).update({ project_key: request.project_key, dataset_name: output.name, schema: windowSchema });
    }
    return { ...recipeInfo(final), verified: true, executed: false, input_settings_reset: inputsChanged, schema_applied: !!windowSchema, limitations: this.limitations(type) };
  }

  async repair(input: unknown) {
    return this.update(repairRecipeSchema.parse(input), false);
  }

  private limitations(type: string): string[] {
    const common = ['Existing outputs must have no other producer. new:true explicitly provisions managed storage.', 'Explicit Window configurations propagate inferred output schemas; other recipe types only provision new output schemas.'];
    if (type === 'window') common.push('Explicit Window uses the DSS engine, full-partition ROWS frame, and hidden GREL null-order keys (null and empty string are equivalent). Template copy only when template is supplied; template input schema must match exactly. Engine execution is not performed by configuration validation.');
    if (type === 'distinct') common.push('Template copy only: native settings are preserved, including keys, sorting, rank/lag/lead or full-row distinct. No arbitrary high-level reconfiguration is available without a verified DSS-version adapter.');
    if (type === 'shaker') common.push('Cast supports string/double only; select/drop must be last. Formula validity and engine compatibility require DSS validation.');
    if (type === 'prompt') common.push('Prompt configuration is saved and read back but never previewed or executed by create/update/repair. Building may transmit selected input columns to the configured LLM connection.');
    return common;
  }
}
