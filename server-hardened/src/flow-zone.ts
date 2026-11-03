import { z } from 'zod';
import { isDeepStrictEqual as equal } from 'node:util';
import { errorDetails, sanitize } from './dss-error.js';
type Obj = Record<string, any>;
interface Transport { get(path: string): Promise<{ data: any }>; post(path: string, body?: unknown): Promise<{ data: any }> }
const id = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/);
export const zoneFields = { zone_id: id.optional(), zone_name: z.string().min(1).optional() };
export const exclusiveZone = (r: { zone_id?: string; zone_name?: string }) => !(r.zone_id && r.zone_name);
export const listZonesSchema = z.strictObject({ project_key: id });
export const flowItemSchema = z.strictObject({ object_type: z.string().min(1), object_id: id, object_project_key: id.optional() });
export const objectZoneSchema = flowItemSchema.extend({ project_key: id });
export const moveFlowSchema = z.strictObject({ project_key: id, target_zone_id: id, items: z.array(flowItemSchema).min(1).max(500), dry_run: z.boolean().default(true) });
export const flowSchema = z.strictObject({ project_key: id, detail: z.enum(['summary', 'detail']).default('detail'), max_objects: z.number().int().min(1).max(10000).default(2000) });
const types: Record<string, string> = { dataset: 'COMPUTABLE_DATASET', recipe: 'RUNNABLE_RECIPE', managed_folder: 'COMPUTABLE_FOLDER',
  saved_model: 'COMPUTABLE_SAVED_MODEL', streaming_endpoint: 'COMPUTABLE_STREAMING_ENDPOINT', labeling_task: 'RUNNABLE_LABELING_TASK',
  knowledge_bank: 'COMPUTABLE_RETRIEVABLE_KNOWLEDGE' };
const nativeTypes: Record<string, string> = { dataset: 'DATASET', recipe: 'RECIPE', managed_folder: 'MANAGED_FOLDER', saved_model: 'SAVED_MODEL',
  streaming_endpoint: 'STREAMING_ENDPOINT', labeling_task: 'LABELING_TASK', knowledge_bank: 'RETRIEVABLE_KNOWLEDGE' };
function check(v: unknown, message: string): asserts v { if (!v) throw new Error(message); }
const key = (o: Obj) => `${o.object_project_key}|${o.object_type}|${o.object_id}`;
export class FlowZoneService {
  constructor(private readonly http: Transport) {}
  async snapshot(project: string) {
    id.parse(project);
    const root = `/projects/${project}/flow`;
    const zones = (await this.http.get(`${root}/zones`)).data;
    const graph = (await this.http.get(`${root}/graph/`)).data;
    check(Array.isArray(zones) && zones.every(z => typeof z.id === 'string' && typeof z.name === 'string' && Array.isArray(z.items)), 'Invalid DSS Flow zones response');
    check(zones.some(z => z.id === 'default'), 'DSS default Flow zone unavailable');
    check(graph?.nodes && typeof graph.nodes === 'object' && !Array.isArray(graph.nodes), 'Invalid DSS Flow graph response');
    check(Object.keys(graph.nodes).length <= 10000, 'Flow exceeds 10000-node safety bound');
    const objects: Obj[] = [], unsupported: Obj[] = [];
    for (const [node_id, node] of Object.entries(graph.nodes) as [string, Obj][]) {
      const object_type = Object.keys(types).find(t => types[t] === node.type);
      if (!object_type) { unsupported.push({ node_id, type: node.type, ref: node.ref }); continue; }
      check(typeof node.ref === 'string', 'Flow node lacks reference');
      const full = String(node.fullId ?? `${project}.${node.ref}`), dot = full.indexOf('.');
      const owner = dot >= 0 ? full.slice(0, dot) : project, name = dot >= 0 ? full.slice(dot + 1) : node.ref;
      const matches = zones.filter(z => z.items.some((item: Obj) => item.objectType === nativeTypes[object_type] && item.objectId === name && (item.projectKey ?? project) === owner));
      check(matches.length <= 1, `Multiple owning zones for ${object_type}:${full}`);
      const zone = matches[0] ?? zones.find(z => z.id === 'default');
      objects.push({ node_id, object_type, object_id: name, object_project_key: owner, full_ref: full,
        zone_id: zone.id, zone_name: zone.name, assignment: matches.length ? 'explicit' : 'default_inferred',
        predecessors: node.predecessors ?? [], successors: node.successors ?? [] });
    }
    check(new Set(objects.map(key)).size === objects.length, 'Ambiguous typed Flow references');
    return { project_key: project, zones, objects, unsupported, graph };
  }
  zoneList(s: Awaited<ReturnType<FlowZoneService['snapshot']>>) {
    return s.zones.map((z: Obj) => ({ zone_id: z.id, name: z.name, is_default: z.id === 'default', color: z.color ?? null,
      object_counts: { datasets: s.objects.filter(o => o.zone_id === z.id && o.object_type === 'dataset').length,
        recipes: s.objects.filter(o => o.zone_id === z.id && o.object_type === 'recipe').length,
        other: s.objects.filter(o => o.zone_id === z.id && !['dataset', 'recipe'].includes(o.object_type)).length } }));
  }
  async list(input: unknown) { const r = listZonesSchema.parse(input), s = await this.snapshot(r.project_key); return { project_key: r.project_key, zones: this.zoneList(s), unsupported_nodes: s.unsupported }; }
  find(s: Awaited<ReturnType<FlowZoneService['snapshot']>>, item: Obj) {
    check(types[item.object_type], `Unsupported Flow object type: ${item.object_type}`);
    const candidates = s.objects.filter(o => o.object_type === item.object_type &&
      (item.object_project_key ? o.object_project_key === item.object_project_key && o.object_id === item.object_id :
        o.full_ref === item.object_id || o.object_id === item.object_id && o.object_project_key === s.project_key));
    check(candidates.length === 1, `Object missing or ambiguous: ${item.object_type}:${item.object_id}`);
    return candidates[0];
  }
  async object(input: unknown): Promise<Obj> { const r = objectZoneSchema.parse(input), s = await this.snapshot(r.project_key); return { project_key: r.project_key, ...this.find(s, r), verified: true }; }
  async resolve(project: string, selector: { zone_id?: string; zone_name?: string }) {
    check(exclusiveZone(selector), 'Use only zone_id or zone_name');
    const s = await this.snapshot(project);
    const matches = s.zones.filter((z: Obj) => selector.zone_id ? z.id === selector.zone_id : selector.zone_name ? z.name === selector.zone_name : z.id === 'default');
    check(matches.length === 1, 'Target Flow zone is missing or ambiguous (names are exact and case-sensitive)');
    return { zone_id: matches[0].id as string, zone_name: matches[0].name as string };
  }
  async flow(input: unknown) {
    const r = flowSchema.parse(input), s = await this.snapshot(r.project_key);
    const bounded = s.objects.slice(0, r.max_objects), nodeIds = new Set(bounded.map(o => o.node_id));
    const edges = bounded.flatMap(o => o.successors.filter((to: string) => nodeIds.has(to)).map((to: string) => ({ from: o.node_id, to })));
    const objects = bounded.map(({ predecessors: _p, successors: _s, ...o }) => { void _p; void _s; return o; });
    return { project_key: r.project_key, zones: this.zoneList(s), object_count: s.objects.length, truncated: bounded.length < s.objects.length,
      datasets: objects.filter(o => o.object_type === 'dataset'), recipes: objects.filter(o => o.object_type === 'recipe'),
      other: objects.filter(o => !['dataset', 'recipe'].includes(o.object_type)), edges: r.detail === 'detail' ? edges : [],
      unassigned: s.unsupported, default_assignment_rule: 'Unlisted owned objects belong to default; shared zone appearances are not ownership.' };
  }
  private assignments(s: Awaited<ReturnType<FlowZoneService['snapshot']>>) { return Object.fromEntries(s.objects.map(o => [key(o), o.zone_id])); }
  private smart(o: Obj, project: string) { return { objectId: o.object_id, objectType: nativeTypes[o.object_type], ...(o.object_project_key === project ? {} : { projectKey: o.object_project_key }) }; }
  async move(input: unknown) {
    const r = moveFlowSchema.parse(input), before = await this.snapshot(r.project_key);
    const target = before.zones.find((z: Obj) => z.id === r.target_zone_id);
    check(target, 'Target Flow zone does not exist');
    const conflicts: string[] = [], items: Obj[] = [];
    for (const item of r.items) { try { items.push(this.find(before, item)); } catch (e) { conflicts.push((e as Error).message); } }
    if (new Set(items.map(key)).size !== items.length) conflicts.push('Duplicate requested Flow item');
    // Official add_items can move producers implicitly. Require each producer and
    // sibling output to be requested or already at target; never silently expand.
    for (const item of items.filter(i => i.zone_id !== target.id)) {
      const producers = item.object_type === 'recipe' ? [item] : before.objects.filter(o => o.object_type === 'recipe' && item.predecessors.includes(o.node_id));
      for (const recipe of producers) for (const related of [recipe, ...before.objects.filter(o => recipe.successors.includes(o.node_id))]) {
        if (related.zone_id !== target.id && !items.some(i => key(i) === key(related))) conflicts.push(`Include related ${related.object_type}:${related.object_id} to avoid implicit move`);
      }
    }
    const diff = items.filter(i => i.zone_id !== target.id).map(i => ({ object_type: i.object_type, object_id: i.object_id,
      object_project_key: i.object_project_key, source_zone_id: i.zone_id, source_zone_name: i.zone_name, target_zone_id: target.id, target_zone_name: target.name }));
    const plan = { project_key: r.project_key, target_zone: { zone_id: target.id, name: target.name }, items,
      conflicts: [...new Set(conflicts)], proposed_diff: diff, writes: 0, executed: false, dry_run: r.dry_run, verified: false, atomic: false };
    if (r.dry_run) return plan;
    check(!conflicts.length, `Flow move preflight failed: ${conflicts.join('; ')}`);
    if (!diff.length) return { ...plan, verified: true };
    const fresh = await this.snapshot(r.project_key);
    check(equal(this.assignments(fresh), this.assignments(before)), 'Flow assignments changed during preflight; retry');
    check(equal(fresh.graph, before.graph), 'Flow topology changed during preflight; retry');
    let writes = 0;
    const post = async (zone: string, objects: Obj[]) => { writes++; await this.http.post(`/projects/${r.project_key}/flow/zones/${zone}/add-items`, objects.map(o => this.smart(o, r.project_key))); };
    try {
      await post(target.id, items.filter(i => i.zone_id !== target.id));
      const after = await this.snapshot(r.project_key), expected = this.assignments(before);
      for (const item of items) expected[key(item)] = target.id;
      check(equal(this.assignments(after), expected), 'Zone assignment read-back mismatch or unexpected collateral move');
      return { ...plan, writes, verified: true, verification: items.map(i => ({ object_id: i.object_id, object_type: i.object_type, zone_id: target.id, verified: true })) };
    } catch (error) {
      let rollback: Obj;
      try {
        const current = await this.snapshot(r.project_key), groups = new Map<string, Obj[]>();
        for (const previous of before.objects) {
          const now = current.objects.find(o => key(o) === key(previous));
          check(now, 'Object disappeared during move; rollback cannot be verified');
          if (now.zone_id !== previous.zone_id) groups.set(previous.zone_id, [...(groups.get(previous.zone_id) ?? []), previous]);
        }
        for (const [zone, group] of groups) await post(zone, group);
        check(equal(this.assignments(await this.snapshot(r.project_key)), this.assignments(before)), 'Rollback assignment mismatch');
        rollback = { verified: true };
      } catch (e) { rollback = { verified: false, error: errorDetails(e) }; }
      throw new Error(JSON.stringify(sanitize({ error: 'Flow move failed', cause: errorDetails(error), writes, rollback, executed: false }, process.env.DSS_API_KEY ?? '')));
    }
  }
}
