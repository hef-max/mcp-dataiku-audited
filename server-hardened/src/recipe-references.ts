import { assert, type NativeObject } from './recipe-config.js';

/** Match dataset identifiers, including project-qualified references, not prefixes
 * in legitimate output names. Inspect object keys as well as string values.
 */
export function retiredInputReferences(previous: string[], current: string[], project: string) {
  const local = (name: string) => name.startsWith(project + '.') ? name.slice(project.length + 1) : name;
  const active = new Set(current.map(local));
  const retired = previous.filter(name => !active.has(local(name))).map(local);
  return new Set(retired.flatMap(name => [name, `${project}.${name}`]));
}
export function hasRetiredReference(value: unknown, retired: Set<string>): boolean {
  if (typeof value === 'string') return (value.match(/[A-Za-z0-9_][A-Za-z0-9_.-]*/g) ?? [])
    .some(token => [...retired].some(name => token === name || token.startsWith(name + '.')));
  if (Array.isArray(value)) return value.some(v => hasRetiredReference(v, retired));
  return !!value && typeof value === 'object' && Object.entries(value).some(([k, v]) => hasRetiredReference(k, retired) || hasRetiredReference(v, retired));
}
export function resetInputSettings(params: unknown, retired: Set<string>): NativeObject {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return {};
  // Reset the entire optional engine block, not just Spark's currently known map.
  // Other engine versions can carry input-bound caches/repartition settings too.
  return Object.fromEntries(Object.entries(params).filter(([key, value]) => key !== 'engineParams' &&
    !hasRetiredReference(key, retired) && !hasRetiredReference(value, retired)));
}
export function assertNoRetiredReferences(payload: unknown, params: unknown, retired: Set<string>) {
  assert(!hasRetiredReference(payload, retired) && !hasRetiredReference(params, retired),
    'Visual recipe contains retired input references in payload or settings; inspect configuration before retrying');
}
