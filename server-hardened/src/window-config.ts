import { isDeepStrictEqual } from 'node:util';
import { assert, type Column, type NativeObject, type WindowRecipeConfig } from './recipe-config.js';
import { datasetSchema } from './dataset-config.js';

// Field provenance: live DSS Window payloads + shipped Window/computed-column UI.
// See WINDOW_RECIPES.md. No template lookup is used by this adapter.
const operations = ['min', 'max', 'avg', 'sum', 'stddev', 'count', 'countDistinct', 'first', 'last',
  'concat', 'concatDistinct', 'lag', 'lagDiff', 'lead', 'leadDiff'];
const rankings = { row_number: ['rowNumber', 'rownumber'], rank: ['rank', 'rank'], dense_rank: ['denseRank', 'denserank'] } as const;

export function buildWindow(config: WindowRecipeConfig, input: Column[]) {
  assert(!config.template && config.partition_by && config.order_by && config.functions, 'Incomplete explicit Window config');
  const names = new Set(input.map(c => c.name));
  assert(names.size === input.length, 'Duplicate input schema columns');
  const column = (name: string) => { const c = input.find(c => c.name === name); assert(c, `Missing column ${name}`); return c; };
  const unique = (items: string[], label: string) => assert(new Set(items).size === items.length, `Duplicate ${label}`);
  unique(config.partition_by, 'partition column');
  unique(config.order_by.map(o => o.column), 'ordering column');
  config.partition_by.forEach(column);
  config.order_by.forEach(o => column(o.column));
  const aliases = config.functions.map(f => f.alias);
  unique(aliases, 'alias');
  assert(aliases.every(a => !names.has(a)), 'Window alias conflicts with an input column');
  const used = new Set([...names, ...aliases]);
  const values = input.map(c => ({ column: c.name, type: c.type, value: true,
    ...Object.fromEntries(operations.map(op => [op, false])), firstLastNotNull: false,
    lagValues: '1', leadValues: '1', dateDiffUnit: 'DAY' } as Record<string, any>));
  const flags: Record<string, boolean> = { rowNumber: false, rank: false, denseRank: false, ntile: false, cumeDist: false };
  const overrides: Record<string, string> = {};
  const derived: Column[] = [];
  for (const f of config.functions) {
    const rank = rankings[f.function as keyof typeof rankings];
    const key = rank ? rank[1] : `${f.column}_${f.function}`;
    assert(!Object.prototype.hasOwnProperty.call(overrides, key), 'Repeated Window function on the same column is unsupported');
    assert(!names.has(key), `Native Window generated name conflicts with input: ${key}`);
    if (rank) {
      assert(f.column === undefined, `${f.function} does not accept column`);
      flags[rank[0]] = true;
      derived.push({ name: f.alias, type: 'bigint' });
    } else {
      assert(f.column, `${f.function} requires column`);
      const c = column(f.column);
      assert(!['array', 'map', 'object'].includes(c.type), `${f.function} requires a scalar column`);
      values.find(v => v.column === f.column)![f.function] = true;
      derived.push({ name: f.alias, type: c.type });
    }
    overrides[key] = f.alias;
  }
  const computedColumns: NativeObject[] = [];
  const orders: { column: string; desc: boolean }[] = [];
  config.order_by.forEach((o, i) => {
    if (o.nulls) {
      let helper = `__mcp_window_null_${i}`;
      while (used.has(helper)) helper += '_';
      used.add(helper);
      computedColumns.push({ name: helper, type: 'bigint', mode: 'GREL', expr: `if(isBlank(val(${JSON.stringify(o.column)})), 1, 0)` });
      orders.push({ column: helper, desc: o.nulls === 'FIRST' });
      values.push({ column: helper, type: 'bigint', value: false,
        ...Object.fromEntries(operations.map(op => [op, false])), firstLastNotNull: false,
        lagValues: '1', leadValues: '1', dateDiffUnit: 'DAY' });
    }
    orders.push({ column: o.column, desc: o.direction === 'DESC' });
  });
  const payload: NativeObject = {
    // Internal DSS engine avoids SQL dialect-specific formula/null ordering differences.
    engineType: 'DSS', preFilter: { enabled: false, distinct: false }, postFilter: { enabled: false, distinct: false },
    retrievedColumnsSelectionMode: 'EXPLICIT', keys: [], values, computedColumns,
    legacyUnboundedWindowStreamBehavior: false, ntileValues: '10', ...flags,
    windows: [{ enablePartitioning: config.partition_by.length > 0, partitioningColumns: config.partition_by,
      enableOrdering: true, orders, enableLimits: true, windowLimitMode: 'ROWS',
      limitPreceding: false, limitFollowing: false, precedingRows: 0, followingRows: 0, windowLowerBound: 0, windowUpperBound: 0 }],
    outputColumnNameOverrides: overrides,
  };
  // Preserve requested output order explicitly via the schema-only endpoint.
  const schema = datasetSchema.parse({ columns: [...input.map(c => ({ name: c.name, type: c.type })), ...derived] });
  return { payload, schema };
}

export function verifyWindow(actual: NativeObject, expected: NativeObject) {
  // Compare semantic fields, tolerating DSS-added UI/default metadata.
  const compare = (a: any, e: any, path: string): void => {
    if (Array.isArray(e)) {
      assert(Array.isArray(a) && a.length === e.length, `Window read-back mismatch: ${path}`);
      e.forEach((v, i) => compare(a[i], v, `${path}[${i}]`));
    } else if (e && typeof e === 'object') {
      assert(a && typeof a === 'object', `Window read-back mismatch: ${path}`);
      for (const [key, value] of Object.entries(e)) compare(a[key], value, `${path}.${key}`);
      if (path === 'outputColumnNameOverrides') assert(isDeepStrictEqual(a, e), `Window read-back mismatch: ${path}`);
    } else assert(isDeepStrictEqual(a, e), `Window read-back mismatch: ${path}`);
  };
  for (const [key, value] of Object.entries(expected)) compare(actual[key], value, key);
}
