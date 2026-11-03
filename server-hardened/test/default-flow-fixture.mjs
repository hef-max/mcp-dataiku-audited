// Default-zone fixture for existing non-zone regression tests. Zone-specific
// tests use a mutable server graph and real assignment verification separately.
export function defaultFlowRead(path) {
  if (path.endsWith('/flow/zones')) return { data: [{ id: 'default', name: 'Default', color: '#000000', items: [] }] };
  if (path.endsWith('/flow/graph/')) {
    const project = path.split('/')[2];
    const nodes = Object.fromEntries(['left', 'right', 'out', 'source', 'existing', 'new_out', 'input', 'new_recipe', 'recipe', 'window'].map(name => [name,
      { type: ['new_recipe', 'recipe', 'window'].includes(name) ? 'RUNNABLE_RECIPE' : 'COMPUTABLE_DATASET', ref: name, fullId: `${project}.${name}`, predecessors: [], successors: [] }]));
    return { data: { nodes } };
  }
}
