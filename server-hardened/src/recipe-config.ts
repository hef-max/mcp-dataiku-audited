import { zoneFields, exclusiveZone } from './flow-zone.js';
import { recipeOutputSchema } from './dataset-config.js';
import { z } from 'zod';
import { sanitize } from './dss-error.js';

const text = z.string().min(1);
const identifier = text.regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/, 'Invalid DSS identifier');
const columns = z.array(text).min(1);
const filter = z.strictObject({ expression: text, language: z.enum(['CUSTOM', 'SQL']).default('CUSTOM') });
const selected = z.strictObject({ dataset: identifier, column: text, alias: text.optional() });
const join = z.strictObject({
  kind: z.literal('join'), join_type: z.enum(['INNER', 'LEFT', 'RIGHT', 'FULL']),
  left: identifier, right: identifier,
  keys: z.array(z.strictObject({ left: text, right: text })).min(1),
  selected_columns: z.array(selected).min(1), post_filter: filter.optional(),
});
const template = z.strictObject({ recipe_name: identifier });
const step = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('parse_date'), column: text, formats: z.array(text).min(1),
    timezone: text.default('UTC'), output_type: z.enum(['date', 'dateonly', 'datetimenotz']), output_column: text.optional() }),
  z.strictObject({ op: z.literal('filter'), expression: text }),
  z.strictObject({ op: z.literal('compute'), column: text, expression: text }),
  z.strictObject({ op: z.literal('rename'), from: text, to: text }),
  z.strictObject({ op: z.literal('cast'), column: text, to: z.enum(['string', 'double']) }),
  z.strictObject({ op: z.literal('trim'), column: text }),
  z.strictObject({ op: z.literal('normalize'), column: text, mode: z.enum(['lower', 'upper']) }),
  z.strictObject({ op: z.literal('select'), columns }),
  z.strictObject({ op: z.literal('drop'), columns }),
]);
const prepare = z.strictObject({ kind: z.literal('shaker'), steps: z.array(step).min(1).optional(), template: template.optional() })
  .refine(c => !!c.steps !== !!c.template, 'Prepare requires exactly one of steps or template');
const stack = z.strictObject({
  kind: z.literal('vstack'), schema_alignment: z.enum(['UNION', 'INTERSECT', 'REMAP']),
  column_mapping: z.record(text, z.record(identifier, text)).optional(),
});
const aggregate = z.strictObject({
  column: text, operation: z.enum(['count_distinct', 'min', 'max', 'sum', 'average']), alias: text.optional(),
});
const grouping = z.strictObject({
  kind: z.literal('grouping'), group_keys: z.array(text),
  count_rows: z.boolean().default(false), aggregations: z.array(aggregate).default([]),
});
// Window adapter provenance and native null-order translation: WINDOW_RECIPES.md.
const windowConfig = z.strictObject({
  kind: z.literal('window'), template: template.optional(),
  partition_by: z.array(text).optional(),
  order_by: z.array(z.strictObject({ column: text, direction: z.enum(['ASC', 'DESC']),
    nulls: z.enum(['FIRST', 'LAST']).optional() })).min(1).optional(),
  functions: z.array(z.strictObject({ function: z.enum(['row_number', 'rank', 'dense_rank', 'min', 'max', 'first', 'last']),
    alias: text, column: text.optional() })).min(1).optional(),
}).superRefine((c, ctx) => {
  const explicit = c.partition_by !== undefined || c.order_by !== undefined || c.functions !== undefined;
  if (c.template ? explicit : !(c.partition_by !== undefined && c.order_by && c.functions))
    ctx.addIssue({ code: 'custom', message: 'Window requires either template or complete partition_by, order_by and functions (not both)' });
});
const distinct = z.strictObject({ kind: z.literal('distinct'), template });
const prompt = z.strictObject({
  kind: z.literal('prompt'),
  llm_id: text,
  prompt: text,
  input_columns: z.array(text).min(1),
  required_json_keys: z.array(text).default([]),
  response_format: z.enum(['JSON_OBJECT', 'TEXT']).default('JSON_OBJECT'),
});
export const recipeConfigSchema = z.discriminatedUnion('kind', [join, prepare, stack, grouping, windowConfig, distinct, prompt]);
export type RecipeConfig = z.infer<typeof recipeConfigSchema>;
export type JoinRecipeConfig = z.infer<typeof join>;
export type PrepareRecipeConfig = z.infer<typeof prepare>;
export type StackRecipeConfig = z.infer<typeof stack>;
export type GroupingRecipeConfig = z.infer<typeof grouping>;
export type WindowRecipeConfig = z.infer<typeof windowConfig>;
export type DistinctRecipeConfig = z.infer<typeof distinct>;
export type PromptRecipeConfig = z.infer<typeof prompt>;
const output = recipeOutputSchema;
export type RecipeOutput = z.infer<typeof output>;
const fields = {
  project_key: identifier, recipe_name: identifier, recipe_type: text,
  inputs: z.array(identifier).min(1), outputs: z.array(output).min(1),
  config: recipeConfigSchema.optional(), code: text.optional(), dry_run: z.boolean().default(false),
};
export const createRecipeSchema = z.strictObject({ ...fields, ...zoneFields, move_existing_outputs: z.boolean().default(false), dry_run: z.boolean().default(true) }).refine(exclusiveZone, 'Use only zone_id or zone_name');
export const updateRecipeSchema = z.strictObject({
  project_key: identifier, recipe_name: identifier,
  recipe_type: text.optional(), inputs: fields.inputs.optional(), outputs: fields.outputs.optional(),
  config: recipeConfigSchema.optional(), code: text.optional(), dry_run: fields.dry_run,
});
export const repairRecipeSchema = z.strictObject({ project_key: identifier, recipe_name: identifier,
  config: recipeConfigSchema, dry_run: fields.dry_run });
export type CreateRecipeRequest = z.input<typeof createRecipeSchema>;
export type UpdateRecipeRequest = z.input<typeof updateRecipeSchema>;
export type ResolvedCreateRecipeRequest = z.output<typeof createRecipeSchema>;
export type Column = { name: string; type: string };
export type Schemas = Record<string, Column[]>;
export type NativeObject = Record<string, unknown>;
export type RecipeEnvelope = { recipe: NativeObject; payload: string; [key: string]: unknown };

export function canonicalType(type: string): string {
  return ({ prepare: 'shaker', stack: 'vstack', sql: 'sql_query' } as Record<string, string>)[type] ?? type;
}
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function requireColumn(schemas: Schemas, dataset: string, name: string): Column {
  const column = schemas[dataset]?.find(c => c.name === name);
  assert(column, `Missing column ${dataset}.${name}`);
  return column;
}
function unique(names: string[], description: string) {
  assert(new Set(names).size === names.length, `Ambiguous or duplicate ${description}`);
}
export function validateRequest(request: ResolvedCreateRecipeRequest) {
  const type = canonicalType(request.recipe_type);
  unique(request.inputs, 'inputs');
  unique(request.outputs.map(o => o.name), 'outputs');
  assert(!request.outputs.some(o => request.inputs.includes(o.name)), 'An output cannot also be an input');
  const visual = ['join', 'shaker', 'vstack', 'grouping', 'window', 'distinct', 'prompt'].includes(type);
  assert(visual || ['python', 'sql_query', 'sql_script'].includes(type), `Unsupported recipe type: ${type}`);
  if (visual) {
    assert(request.config?.kind === type, 'recipe_type must match config.kind');
    assert(request.code === undefined, 'Visual recipes cannot contain code');
    assert(request.outputs.length === 1, 'Visual recipes require exactly one output');
    if (type !== 'join' && type !== 'vstack') assert(request.inputs.length === 1, `${type} requires one input`);
  } else {
    assert(!request.config, 'Code recipes cannot contain visual config');
    assert(request.code?.trim(), 'Code recipes require nonempty code');
  }
  for (const output of request.outputs) {
    assert(output.new || Object.keys(output).every(k => k === 'name' || k === 'new'), 'Storage settings require new: true');
    if (output.new) assert(output.path, 'A new explicit path is required for output provisioning');
  }
}
const disabledFilter = () => ({ enabled: false, distinct: false });
const nativeFilter = (f?: z.infer<typeof filter>) => f
  ? { enabled: true, distinct: false, uiData: { mode: f.language }, expression: f.expression }
  : disabledFilter();
export function inspectPayload(envelope: RecipeEnvelope) {
  const raw: unknown = envelope.payload;
  if (raw == null || typeof raw === 'string' && !raw.trim()) return { format: 'EMPTY', config: null, diagnostic: 'Recipe exists but visual payload is empty' };
  try {
    const payload: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Expected object');
    return { format: 'DSS_NATIVE_PAYLOAD', config: payload as NativeObject, diagnostic: undefined };
  } catch {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    return { format: 'INVALID', config: null, diagnostic: JSON.stringify({ error: 'Invalid visual recipe payload',
      recipe: envelope.recipe.name, body_length: Buffer.byteLength(text), excerpt: sanitize(text, process.env.DSS_API_KEY ?? '').slice(0, 1000) }) };
  }
}
export function parsePayload(envelope: RecipeEnvelope): NativeObject {
  const result = inspectPayload(envelope);
  assert(result.config, result.diagnostic ?? 'Invalid native visual payload');
  return result.config;
}
export function buildVisualPayload(request: ResolvedCreateRecipeRequest, schemas: Schemas): NativeObject {
  const config = request.config!;
  const source = request.inputs[0];
  const check = (name: string) => requireColumn(schemas, source, name);
  switch (config.kind) {
    case 'join': {
      assert(request.inputs.length === 2 && config.left !== config.right && request.inputs.includes(config.left) && request.inputs.includes(config.right),
        'Join requires exactly the two distinct left/right inputs');
      const left = request.inputs.indexOf(config.left), right = request.inputs.indexOf(config.right);
      config.keys.forEach(k => { requireColumn(schemas, config.left, k.left); requireColumn(schemas, config.right, k.right); });
      unique(config.selected_columns.map(c => c.alias ?? c.column), 'selected output columns');
      return {
        virtualInputs: request.inputs.map((name, index) => ({ index, alias: name, originLabel: name,
          outputColumnsSelectionMode: 'MANUAL', preFilter: disabledFilter(), computedColumns: [] })),
        joins: [{ type: config.join_type, table1: left, table2: right, conditionsMode: 'AND', rightLimit: { enabled: false, maxMatches: 1, strict: false },
          on: config.keys.map(k => ({ type: 'EQ', column1: { table: left, name: k.left }, column2: { table: right, name: k.right } })) }],
        selectedColumns: config.selected_columns.map(c => {
          assert(request.inputs.includes(c.dataset), 'Selected column references a non-input dataset');
          return { name: c.column, table: request.inputs.indexOf(c.dataset), type: requireColumn(schemas, c.dataset, c.column).type,
            ...(c.alias ? { alias: c.alias } : {}) };
        }), resolvedSelectedColumns: [], computedColumns: [], postFilter: nativeFilter(config.post_filter),
      };
    }
    case 'shaker': {
      const current = new Map(schemas[source].map(c => [c.name, c.type]));
      const steps: NativeObject[] = [];
      let dropped: string[] = [];
      const add = (type: string, params: NativeObject) => steps.push({ metaType: 'PROCESSOR', type, params, disabled: false });
      const exists = (name: string) => assert(current.has(name), `Missing column ${source}.${name} at Prepare step`);
      let projected = false;
      assert(config.steps && !config.template, 'Explicit Prepare requires steps without template');
      for (const s of config.steps) {
        assert(!projected, 'Select/drop columns must be the last Prepare step');
        if (s.op === 'parse_date') {
          exists(s.column);
          try { new Intl.DateTimeFormat('en', { timeZone: s.timezone }); }
          catch { throw new Error('Invalid parse_date timezone; use an IANA timezone or UTC'); }
          const target = s.output_column ?? s.column;
          assert(target === s.column || !current.has(target), `DateParser output already exists: ${target}`);
          add('DateParser', { appliesTo: 'SINGLE_COLUMN', columns: [s.column], formats: s.formats,
            timezone_id: s.timezone, lang: 'auto', outCol: target === s.column ? '' : target,
            outType: { name: 'out', type: s.output_type } });
          current.set(target, s.output_type);
        } else if (s.op === 'filter') add('FilterOnCustomFormula', { expression: s.expression, action: 'KEEP_ROW' });
        else if (s.op === 'compute') { add('CreateColumnWithGREL', { column: s.column, expression: s.expression, errorColumn: '' }); current.set(s.column, 'string'); }
        else if (s.op === 'rename') {
          exists(s.from); assert(!current.has(s.to), `Rename target already exists: ${s.to}`);
          add('ColumnRenamer', { renamings: [{ from: s.from, to: s.to }] });
          current.set(s.to, current.get(s.from)!); current.delete(s.from);
        } else if (s.op === 'select' || s.op === 'drop') {
          unique(s.columns, 'projection columns'); s.columns.forEach(exists);
          dropped = [...current.keys()].filter(name => s.op === 'select' ? !s.columns.includes(name) : s.columns.includes(name));
          dropped.forEach(name => current.delete(name));
          assert(current.size, 'Prepare cannot drop all columns'); projected = true;
        } else {
          exists(s.column);
          const value = `strval(${JSON.stringify(s.column)})`;
          const fn = s.op === 'cast' ? (s.to === 'string' ? 'strval' : 'numval') : s.op === 'trim' ? 'trim' : s.mode === 'lower' ? 'toLowercase' : 'toUppercase';
          const expression = s.op === 'cast'
            ? s.to === 'string' && current.get(s.column) !== 'string' ? `toString(val(${JSON.stringify(s.column)}))` : `${fn}(${JSON.stringify(s.column)})`
            : `${fn}(${value})`;
          add('CreateColumnWithGREL', { column: s.column, expression, errorColumn: '' });
          if (s.op === 'cast') current.set(s.column, s.to);
        }
      }
      return { steps, columnsSelection: { mode: 'ALL', list: dropped.map(name => ({ name, d: true })) } };
    }
    case 'vstack': {
      assert(request.inputs.length >= 2, 'Stack requires at least two inputs');
      const virtualInputs = request.inputs.map((name, index) => ({ index, originLabel: name, preFilter: disabledFilter(), columnsMatch: [] as string[] }));
      if (config.schema_alignment === 'REMAP') {
        assert(config.column_mapping && Object.keys(config.column_mapping).length, 'REMAP requires column_mapping');
        for (const sources of Object.values(config.column_mapping)) {
          assert(Object.keys(sources).length, 'Each mapped output column needs a source');
          Object.entries(sources).forEach(([dataset, column]) => {
            assert(request.inputs.includes(dataset), 'Mapping references a non-input dataset'); requireColumn(schemas, dataset, column);
          });
        }
        for (const [i, name] of request.inputs.entries()) virtualInputs[i].columnsMatch = Object.values(config.column_mapping).map(m => m[name] ?? '');
      } else assert(!config.column_mapping, 'column_mapping is only valid for REMAP');
      // Reject type conflicts rather than silently coercing identifiers or dates.
      const names = config.column_mapping ? Object.keys(config.column_mapping) : [...new Set(request.inputs.flatMap(i => schemas[i].map(c => c.name)))];
      for (const name of names) {
        const types = request.inputs.flatMap(i => schemas[i].filter(c => c.name === (config.column_mapping ? config.column_mapping[name]?.[i] : name)).map(c => c.type));
        assert(new Set(types).size <= 1, `Stack type conflict for ${name}; cast inputs explicitly first`);
      }
      return { mode: config.schema_alignment, virtualInputs, addOriginColumn: false,
        selectedColumns: config.column_mapping ? Object.keys(config.column_mapping) : [], postFilter: disabledFilter() };
    }
    case 'grouping': {
      unique(config.group_keys, 'group keys'); config.group_keys.forEach(check);
      assert(config.count_rows || config.aggregations.length, 'Grouping requires count_rows or aggregations');
      const values = new Map<string, NativeObject>();
      const overrides: Record<string, string> = {};
      const outputNames = [...config.group_keys, ...(config.count_rows ? ['count'] : [])];
      const aggregateKeys: string[] = [];
      for (const a of config.aggregations) {
        const column = check(a.column);
        assert(!config.group_keys.includes(a.column), 'Aggregating a grouping key is not supported by this adapter');
        if (['sum', 'average'].includes(a.operation)) assert(['tinyint', 'smallint', 'int', 'bigint', 'float', 'double', 'decimal'].includes(column.type), `Numeric aggregation requires numeric column: ${a.column}`);
        const operation = a.operation === 'count_distinct' ? 'countDistinct' : a.operation === 'average' ? 'avg' : a.operation;
        const suffix = a.operation === 'count_distinct' ? 'distinct' : a.operation === 'average' ? 'avg' : a.operation;
        const defaultName = `${a.column}_${suffix}`;
        aggregateKeys.push(defaultName); outputNames.push(a.alias ?? defaultName);
        values.set(a.column, { ...values.get(a.column), column: a.column, type: column.type, [operation]: true });
        if (a.alias) overrides[defaultName] = a.alias;
      }
      unique(aggregateKeys, 'aggregations'); unique(outputNames, 'aggregation output names');
      return { keys: config.group_keys.map(column => ({ column, type: check(column).type })), values: [...values.values()],
        globalCount: config.count_rows, outputColumnNameOverrides: overrides, selectAllColumns: false,
        computedColumns: [], preFilter: disabledFilter(), postFilter: disabledFilter() };
    }
    case 'prompt': {
      unique(config.input_columns, 'Prompt input columns');
      unique(config.required_json_keys, 'Prompt required JSON keys');
      config.input_columns.forEach(check);
      for (const column of config.input_columns) {
        assert(config.prompt.includes(`{{${column}}}`), `Prompt template does not reference input column: ${column}`);
      }
      const json = config.response_format === 'JSON_OBJECT';
      assert(json || config.required_json_keys.length === 0, 'required_json_keys requires JSON_OBJECT response_format');
      return {
        filter: { uiData: { mode: '&&', conditions: [] }, distinct: false, enabled: false },
        rawQueryOutputMode: 'RAW_WITHOUT_FULL_IMAGES', passContext: false,
        context: { mode: 'KEY_VALUE', jsonField: { fromColumn: false, value: '{}' }, fields: [] },
        completionSettings: { stopSequences: [], ...(json ? { responseFormat: { compatible: true, type: 'json' } } : {}) },
        rawResponseOutputMode: 'RAW_WITHOUT_TRACES', llmId: config.llm_id,
        prompt: {
          guardrailsPipelineSettings: { guardrails: [] },
          promptTemplateInputs: config.input_columns.map(column => ({ datasetColumnName: column, name: column, type: 'TEXT' })),
          resultValidation: { requiredJSONObjectKeys: config.required_json_keys,
            expectedFormat: json ? 'JSON_OBJECT' : 'NONE', forbiddenTerms: [] },
          promptTemplateQueriesSource: 'DATASET', streamingDisabled: false, chatMessages: {}, structuredPromptExamples: [],
          textPromptTemplateInputs: [], debugEventsEnabled: false, promptMode: 'PROMPT_TEMPLATE_STRUCTURED',
          structuredPromptPrefix: config.prompt,
        },
        performFiltering: false,
      };
    }
    default: throw new Error(`${config.kind} requires a same-project native template with identical input schema; use template recipe_name`);
  }
}

export function recipeInfo(envelope: RecipeEnvelope) {
  const type = String(envelope.recipe.type);
  const visual = ['join', 'shaker', 'vstack', 'grouping', 'window', 'distinct', 'prompt'].includes(type);
  const inspected = visual ? inspectPayload(envelope) : null;
  const config = inspected?.config ?? null;
  return { recipe_name: envelope.recipe.name, recipe_type: type,
    inputs: envelope.recipe.inputs, outputs: envelope.recipe.outputs,
    config, configuration_format: inspected?.format ?? 'CODE', diagnostic: inspected?.diagnostic,
    recipe_metadata: envelope.recipe, recipe_payload: envelope.payload, recipe_settings: envelope.recipe.params ?? {},
    code: visual ? undefined : envelope.payload,
    join_keys: config?.joins ?? null,
    filters: config ? { pre: config.preFilter ?? null, post: config.postFilter ?? null,
      prepare_steps: config.steps ?? null } : null,
    selected_columns: config?.selectedColumns ?? config?.columnsSelection ?? null,
    aggregations: config ? { keys: config.keys ?? null, values: config.values ?? null, count_rows: config.globalCount ?? null } : null,
    window_settings: type === 'window' ? config : null,
    raw: envelope };
}
