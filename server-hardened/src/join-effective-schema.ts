type Obj = Record<string, any>;
const keywords = new Set('CASE WHEN THEN ELSE END NULL TRUE FALSE IS NOT AND OR IN LIKE BETWEEN AS CAST TRY_CAST DISTINCT FROM INTERVAL YEAR MONTH DAY HOUR MINUTE SECOND ASC DESC TIMESTAMP DATE TIME VARCHAR CHAR STRING INTEGER INT BIGINT DOUBLE FLOAT DECIMAL NUMERIC BOOLEAN REGEXP RLIKE DIV MOD'.split(' '));

/** Validate native references without reconstructing or modifying native logic.
 * Expression checking is deliberately limited to SQL identifiers and DSS val()
 * references; this is not a replacement for the DSS expression compiler.
 */
export function validateJoinSchemas(recipe: string, payload: Obj, physical: Obj[][]) {
  const effective = payload.virtualInputs.map((v: Obj, index: number) => {
    if (!Array.isArray(v.computedColumns ?? [])) throw new Error(`Recipe ${recipe}: invalid computedColumns at slot ${index}`);
    return { index, position: index + 1, alias: v.alias ?? v.originLabel, physical_columns: physical[index],
      computed_columns: structuredClone(v.computedColumns ?? []), effective_columns: [...physical[index]] };
  }) as Obj[];
  const fail = (index: number, column: string, location: string, reason = 'unavailable'): never => {
    throw new Error(JSON.stringify({ error: `Join column ${reason}`, recipe_name: recipe, slot: index,
      alias: effective[index]?.alias ?? 'post-join output / all slots', column, location, searched: ['physical schema', 'computed columns on the same slot'] }));
  };
  const check = (index: number, name: string, location: string, available?: Set<string>) => {
    if (!effective[index]) fail(index, name, location, 'has invalid slot');
    if (!(available ?? new Set(effective[index].effective_columns.map((c: Obj) => c.name))).has(name)) fail(index, name, location);
  };
  const expression = (text: string, mode: string, index: number | undefined, location: string, available?: Set<string>) => {
    const refs: string[] = [];
    // SQL quoted identifiers differ from formula string literals. Explicit val()
    // column names are supported in formula mode without interpreting literals.
    if (mode !== 'SQL') for (const m of text.matchAll(/\bval\(\s*['"]([^'"]+)['"]\s*\)/g)) refs.push(m[1]);
    const stripped = text.replace(/'(?:''|[^'])*'/g, ' ');
    const tokenText = mode === 'SQL' ? stripped : stripped.replace(/"(?:\\.|[^"\\])*"/g, ' ');
    const tokens = [...tokenText.matchAll(/"(?:""|[^"])*"|`(?:``|[^`])*`|[A-Za-z_][A-Za-z0-9_]*|\.|\(|\d+(?:\.\d+)?/g)];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i][0]; if (!/^[A-Za-z_"`]/.test(token)) continue;
      const quoted = /^["`]/.test(token), name = quoted ? token.slice(1, -1).replace(/""/g, '"').replace(/``/g, '`') : token;
      if (!name) continue; // Empty quoted literals cannot denote a column.
      if (tokens[i + 1]?.[0] === '.') {
        const columnToken = tokens[i + 2]?.[0];
        const target = effective.find(s => s.alias === name || payload.virtualInputs[s.index].originLabel === name);
        if (!target || !columnToken) fail(index ?? -1, name, location, 'has unsupported qualifier');
        check(target!.index, columnToken.replace(/^["`]|["`]$/g, ''), location, target!.index === index ? available : undefined); i += 2; continue;
      }
      if (!quoted && (keywords.has(name.toUpperCase()) || tokens[i + 1]?.[0] === '(')) continue;
      refs.push(name);
    }
    for (const name of refs) {
      if (index !== undefined) check(index, name, location, available);
      else {
        // Post-join expressions may address selected output aliases.
        const selected = payload.selectedColumns.filter((c: Obj) => (c.alias || c.name) === name);
        if (selected.length) for (const c of selected) check(c.table, c.name, location);
        else {
          const candidates = effective.filter(s => s.effective_columns.some((c: Obj) => c.name === name));
          if (!candidates.length) fail(-1, name, location);
        }
      }
    }
  };
  for (const s of effective) {
    const available = new Set<string>(s.physical_columns.map((c: Obj) => c.name));
    for (const [i, c] of s.computed_columns.entries()) {
      const location = `virtualInputs[${s.index}].computedColumns[${i}]`;
      if (typeof c.name !== 'string' || typeof c.type !== 'string' || typeof c.expr !== 'string') fail(s.index, String(c.name), location, 'has invalid computed definition');
      if (available.has(c.name)) fail(s.index, c.name, location, 'is duplicated');
      expression(c.expr, c.mode ?? 'SQL', s.index, location + '.expr', available);
      available.add(c.name); s.effective_columns.push({ name: c.name, type: c.type, source: 'computed' });
    }
  }
  const walk = (value: any, location: string, index?: number) => {
    if (!value || typeof value !== 'object' || value.enabled === false) return;
    if (Number.isInteger(value.table) && typeof value.name === 'string') check(value.table, value.name, location);
    if (typeof value.column === 'string') {
      if (index !== undefined) check(index, value.column, location + '.column');
      else expression('"' + value.column.replace(/"/g, '""') + '"', 'SQL', undefined, location + '.column');
    }
    for (const [key, child] of Object.entries(value)) {
      if (['expr', 'expression'].includes(key) && typeof child === 'string') expression(child, value.mode ?? 'SQL', index, location + '.' + key);
      else if (child && typeof child === 'object') walk(child, `${location}.${key}`, index);
    }
  };
  walk(payload.selectedColumns, 'selectedColumns'); walk(payload.joins, 'joins'); walk(payload.postFilter, 'postFilter');
  effective.forEach(s => walk(payload.virtualInputs[s.index].preFilter, `virtualInputs[${s.index}].preFilter`, s.index));
  return effective;
}
