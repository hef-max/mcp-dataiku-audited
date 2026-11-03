import { FlowZoneService } from './flow-zone.js';
import { InputReplacementService } from './input-replacement.js';
import { randomUUID } from 'node:crypto';
import { sampleRequestSchema, readTsvSample } from './dataset-sample.js';
import { RecipeService } from './recipe-service.js';
import { SchemaService } from './schema-service.js';
import type { UpdateDatasetRequest } from './dataset-config.js';
import { JobService, type BuildDatasetRequest, type RunRecipeRequest, type JobRequest } from './job-service.js';
import { DatasetService } from './dataset-service.js';
import type { CreateDatasetRequest } from './dataset-config.js';
import { DssHttpError, readBody, parseSuccessBody } from './dss-error.js';
import type { RecipeConfig } from './recipe-config.js';
type QueryValue = string | number | boolean | undefined;
type RequestOptions = { params?: Record<string, QueryValue>; timeoutMs?: number; responseType?: 'text'; sample?: { rows: number; width: number } };

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export class SecureHttpClient {
  constructor(
    private readonly baseUrl: URL,
    private readonly apiKey: string,
    private readonly readOnly = false,
  ) {}

  private async request(
    method: string,
    relativePath: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<{ data: any }> {
    if (this.readOnly && method !== 'GET') throw new Error('Read-only client rejects all non-GET requests');
    const cleanPath = relativePath.replace(/^\/+/, '');
    const url = new URL(cleanPath, this.baseUrl);
    for (const [key, value] of Object.entries(options.params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(Math.min(DEFAULT_TIMEOUT_MS, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new Error('Dataiku API request timed out');
      }
      throw new Error('Unable to connect securely to Dataiku DSS');
    }

    if (!response.ok) {
      let body: unknown;
      try {
        if (/zip|octet-stream/i.test(response.headers.get('content-type') ?? '')) {
          await response.body?.cancel(); body = '[Binary response body omitted]';
        } else {
          const raw = await readBody(response, 64 * 1024);
          if (raw.startsWith('PK\u0003\u0004')) body = '[ZIP response body omitted]';
          else { try { body = JSON.parse(raw); } catch { body = raw; } }
        }
      } catch { body = '[Response body omitted: unreadable or exceeds safe size limit]'; }
      throw new DssHttpError(response.status, method, relativePath, body, this.apiKey);
    }

    if (options.sample) {
      if (/html|json/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel();
        throw new Error('DSS data endpoint returned a non-TSV response');
      }
      return { data: await readTsvSample(response, options.sample.rows, options.sample.width) };
    }
    if (/zip|octet-stream/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw new Error('Binary DSS response omitted; use structured configuration tools or a dedicated archive download'); }
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_RESPONSE_BYTES) {
      throw new Error('Dataiku API response exceeded the configured size limit');
    }

    const text = await readBody(response, MAX_RESPONSE_BYTES);
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new Error('Dataiku API response exceeded the configured size limit');
    }
    if (text.startsWith('PK\u0003\u0004')) throw new Error('ZIP archive omitted; binary content cannot be returned as text');
    return { data: parseSuccessBody(response.status, method, relativePath, response.headers.get('content-type') ?? '', text, this.apiKey, options.responseType === 'text') };
  }

  get(path: string, options?: RequestOptions) {
    return this.request('GET', path, undefined, options);
  }
  getText(path: string, options?: RequestOptions) {
    return this.request('GET', path, undefined, { ...options, responseType: 'text' });
  }
  post(path: string, body?: unknown) {
    return this.request('POST', path, body);
  }
  put(path: string, body?: unknown) {
    return this.request('PUT', path, body);
  }
  delete(path: string, options?: RequestOptions) {
    return this.request('DELETE', path, undefined, options);
  }
}
export interface DataikuConfig {
  host: string;
  apiKey: string;
  insecureTls?: boolean;
  readOnly?: boolean;
}

export interface DatasetSchema {
  columns: Array<{
    name: string;
    type: string;
    comment?: string;
  }>;
}

export interface DatasetMetrics {
  records: number;
  size: number;
  lastModified?: string;
}

export interface RecipeDefinition {
  type: string;
  name: string;
  inputs: string[];
  outputs: import('./recipe-config.js').RecipeOutput[];
  code?: string;
  params?: Record<string, any>;
  config?: RecipeConfig;
  dry_run?: boolean;
  zone_id?: string; zone_name?: string; move_existing_outputs?: boolean;
}

export interface ScenarioDefinition {
  id?: string;
  name: string;
  type: 'step_based' | 'custom_python';
  definition?: Record<string, any>;
  triggers?: Array<Record<string, any>>;
}

export interface JobInfo {
  id: string;
  type: string;
  status: string;
  startTime?: string;
  endTime?: string;
  error?: string;
}

export class DataikuClient {
  private client: SecureHttpClient;
  private config: DataikuConfig;

  constructor(config?: Partial<DataikuConfig>) {
    this.config = {
      host: config?.host || process.env.DSS_HOST || '',
      apiKey: config?.apiKey || process.env.DSS_API_KEY || '',
      insecureTls: config?.insecureTls || process.env.DSS_INSECURE_TLS === 'true',
    };

    if (!this.config.host || !this.config.apiKey) {
      throw new Error('Dataiku DSS host and API key are required');
    }

    if (this.config.insecureTls) {
      throw new Error('DSS_INSECURE_TLS is not supported by the hardened server');
    }

    let host: URL;
    try {
      host = new URL(this.config.host);
    } catch {
      throw new Error('DSS_HOST must be a valid HTTPS URL');
    }
    if (host.protocol !== 'https:') {
      throw new Error('DSS_HOST must use HTTPS');
    }
    if (host.username || host.password || host.search || host.hash) {
      throw new Error('DSS_HOST must not contain credentials, query parameters, or fragments');
    }

    const normalizedPath = host.pathname.replace(/\/+$/, '');
    host.pathname = normalizedPath.includes('/public/api')
      ? `${normalizedPath}/`
      : `${normalizedPath}/public/api/`;

    this.client = new SecureHttpClient(host, this.config.apiKey, config?.readOnly ?? process.env.DSS_READ_ONLY === 'true');
  }

  // Project operations
  async listProjects(): Promise<Array<{ key: string; name: string; description?: string }>> {
    const response = await this.client.get('/projects/');
    return response.data.map((project: any) => ({
      key: project.projectKey || project.key || 'unknown',
      name: project.name || project.projectName || 'Unnamed Project',
      description: project.description || project.shortDesc || ''
    }));
  }

  async getProject(projectKey: string): Promise<any> {
    const response = await this.client.get(`/projects/${projectKey}`);
    return response.data;
  }

  async listFlowZones(input: unknown) { return new FlowZoneService(this.client).list(input); }
  async getFlowObjectZone(input: unknown) { return new FlowZoneService(this.client).object(input); }
  async moveFlowItems(input: unknown) { return new FlowZoneService(this.client).move(input); }
  async getProjectFlow(projectKey: string, options: Record<string, unknown> = {}): Promise<any> {
    return new FlowZoneService(this.client).flow({ ...options, project_key: projectKey });
  }

  // Dataset operations
  async listDatasets(projectKey: string): Promise<any[]> {
    const response = await this.client.get(`/projects/${projectKey}/datasets/`);
    return response.data;
  }

  async getDataset(projectKey: string, datasetName: string): Promise<any> {
    const response = await this.client.get(`/projects/${projectKey}/datasets/${datasetName}`);
    return response.data;
  }

  async createDataset(request: CreateDatasetRequest): Promise<any> {
    return new DatasetService(this.client).create(request);
  }

  async updateDataset(request: UpdateDatasetRequest) {
    return new SchemaService(this.client).update(request);
  }

  async deleteDataset(projectKey: string, datasetName: string, dropData: boolean = false): Promise<any> {
    const response = await this.client.delete(`/projects/${projectKey}/datasets/${datasetName}`, {
      params: { dropData },
    });
    return response.data;
  }

  async buildDataset(request: BuildDatasetRequest) {
    return new JobService(this.client, this.config.apiKey).build(request);
  }

  async getDatasetSchema(projectKey: string, datasetName: string): Promise<DatasetSchema> {
    const response = await this.client.get(`/projects/${projectKey}/datasets/${datasetName}/schema`);
    return response.data;
  }

  async getDatasetMetrics(projectKey: string, datasetName: string): Promise<DatasetMetrics> {
    const response = await this.client.get(`/projects/${projectKey}/datasets/${datasetName}/metrics/last/NP`);
    return response.data;
  }

  async getDatasetInfo(projectKey: string, datasetName: string): Promise<any> {
    const response = await this.client.get(`/projects/${projectKey}/datasets/${datasetName}`);
    return response.data;
  }

  async clearDataset(projectKey: string, datasetName: string, partition?: string): Promise<any> {
    const params: Record<string, any> = {};
    if (partition) {
      params.partitions = partition;
    }
    const response = await this.client.post(`/projects/${projectKey}/datasets/${datasetName}/clear`, params);
    return response.data;
  }

  async getDatasetSample(projectKey: string, datasetName: string, rows: number = 100, columns?: string[]): Promise<any> {
    const request = sampleRequestSchema.parse({ project_key: projectKey, dataset_name: datasetName, rows, columns });
    const schema = await this.getDatasetSchema(request.project_key, request.dataset_name);
    if (!Array.isArray(schema?.columns) || !schema.columns.length || schema.columns.some(c => typeof c.name !== 'string')) throw new Error('Invalid dataset schema for sample');
    const names = schema.columns.map(c => c.name);
    if (new Set(names).size !== names.length) throw new Error('Ambiguous dataset schema for sample');
    const selected = request.columns ?? names;
    if (selected.some(c => !names.includes(c))) throw new Error('Requested sample column is absent from dataset schema');
    const readSessionId = randomUUID();
    const root = `/projects/${request.project_key}/datasets/${request.dataset_name}`;
    const response = await this.client.get(`${root}/data/`, { params: { format: 'tsv-excel-noheader', readSessionId },
      sample: { rows: request.rows, width: names.length } });
    // Official client checks stream errors after exhaustion. Early cancellation is
    // deliberately not reported as full-stream validation or a complete dataset.
    if (response.data.complete) await this.client.get(`${root}/finish-streaming/`, { params: { readSessionId } });
    const indices = selected.map(c => names.indexOf(c));
    return { ...response.data, columns: selected.map(name => schema.columns.find(c => c.name === name)),
      rows: response.data.rows.map((row: string[]) => indices.map(i => row[i])),
      sampling: 'HEAD', values_format: 'strings', max_rows: 1000, max_bytes: 1048576 };

  }

  // Recipe operations
  async listRecipes(projectKey: string): Promise<any[]> {
    const response = await this.client.get(`/projects/${projectKey}/recipes/`);
    return response.data;
  }

  async getRecipe(projectKey: string, recipeName: string): Promise<any> {
    const response = await this.client.get(`/projects/${projectKey}/recipes/${recipeName}`);
    return response.data;
  }

  async getRecipeInfo(projectKey: string, recipeName: string): Promise<any> {
    return new RecipeService(this.client).info(projectKey, recipeName);
  }

  async validateRecipeSyntax(projectKey: string, recipeName: string, code?: string): Promise<any> {
    const data: Record<string, any> = {};
    if (code) {
      data.code = code;
    }
    const response = await this.client.post(`/projects/${projectKey}/recipes/${recipeName}/validate`, data);
    return response.data;
  }

  async testRecipeDryRun(projectKey: string, recipeName: string, sampleRows: number = 100): Promise<any> {
    const params = { sampleRows };
    const response = await this.client.get(`/projects/${projectKey}/recipes/${recipeName}/dry-run`, { params });
    return response.data;
  }

  async createRecipe(projectKey: string, recipe: RecipeDefinition): Promise<any> {
    if (recipe.params) throw new Error('Legacy params is unsupported; use typed config');
    return new RecipeService(this.client).create({ project_key: projectKey, recipe_name: recipe.name,
      recipe_type: recipe.type, inputs: recipe.inputs, outputs: recipe.outputs,
      code: recipe.code, config: recipe.config, dry_run: recipe.dry_run, zone_id: recipe.zone_id, zone_name: recipe.zone_name, move_existing_outputs: recipe.move_existing_outputs });
  }

  async updateRecipe(projectKey: string, recipeName: string, updates: Record<string, any>): Promise<any> {
    return new RecipeService(this.client).update({ ...updates, project_key: projectKey, recipe_name: recipeName });
  }
  async replaceVisualRecipeInput(request: unknown) {
    return new InputReplacementService(this.client, this.config.apiKey).replace(request);
  }

  async repairRecipeConfiguration(request: unknown) {
    return new RecipeService(this.client).repair(request);
  }

  async deleteRecipe(projectKey: string, recipeName: string): Promise<any> {
    const response = await this.client.delete(`/projects/${projectKey}/recipes/${recipeName}`);
    return response.data;
  }

  async runRecipe(request: RunRecipeRequest) {
    return new JobService(this.client, this.config.apiKey).runRecipe(request);
  }

  // Scenario operations
  async getScenario(projectKey: string, scenarioId: string): Promise<any> {
    const response = await this.client.get(`/projects/${projectKey}/scenarios/${scenarioId}`);
    return response.data;
  }

  async listScenarios(projectKey: string, scenarioType?: string, activeOnly?: boolean): Promise<any[]> {
    const params: Record<string, any> = {};
    if (scenarioType) params.type = scenarioType;
    if (activeOnly) params.active = true;

    const response = await this.client.get(`/projects/${projectKey}/scenarios/`, { params });
    return response.data;
  }

  async getScenarioRunHistory(projectKey: string, scenarioId: string, limit: number = 10): Promise<any> {
    const params = { limit };
    const response = await this.client.get(`/projects/${projectKey}/scenarios/${scenarioId}/runs`, { params });
    return response.data;
  }

  async createScenario(projectKey: string, scenario: ScenarioDefinition): Promise<any> {
    const data = {
      id: scenario.id || scenario.name.toLowerCase().replace(/\s+/g, '_'),
      name: scenario.name,
      type: scenario.type,
      definition: scenario.definition || {},
    };
    const response = await this.client.post(`/projects/${projectKey}/scenarios/`, data);
    return response.data;
  }

  async updateScenario(projectKey: string, scenarioId: string, updates: Record<string, any>): Promise<any> {
    const response = await this.client.put(`/projects/${projectKey}/scenarios/${scenarioId}`, updates);
    return response.data;
  }

  async deleteScenario(projectKey: string, scenarioId: string): Promise<any> {
    const response = await this.client.delete(`/projects/${projectKey}/scenarios/${scenarioId}`);
    return response.data;
  }

  async runScenario(projectKey: string, scenarioId: string): Promise<any> {
    const response = await this.client.post(`/projects/${projectKey}/scenarios/${scenarioId}/run`);
    return response.data;
  }

  async addScenarioTrigger(
    projectKey: string,
    scenarioId: string,
    triggerType: 'periodic' | 'hourly' | 'daily' | 'monthly' | 'dataset',
    params: Record<string, any>
  ): Promise<any> {
    const data = {
      triggerType,
      ...params,
    };
    const response = await this.client.post(`/projects/${projectKey}/scenarios/${scenarioId}/triggers`, data);
    return response.data;
  }

  async removeScenarioTrigger(projectKey: string, scenarioId: string, triggerIdx: number): Promise<any> {
    const response = await this.client.delete(`/projects/${projectKey}/scenarios/${scenarioId}/triggers/${triggerIdx}`);
    return response.data;
  }

  async getScenarioInfo(projectKey: string, scenarioId: string): Promise<any> {
    const response = await this.client.get(`/projects/${projectKey}/scenarios/${scenarioId}/info`);
    return response.data;
  }

  async getScenarioSteps(projectKey: string, scenarioId: string): Promise<any> {
    const response = await this.client.get(`/projects/${projectKey}/scenarios/${scenarioId}/steps`);
    return response.data;
  }

  async getScenarioLogs(projectKey: string, scenarioId: string, runId?: string): Promise<any> {
    const params = runId ? { runId } : {};
    const response = await this.client.get(`/projects/${projectKey}/scenarios/${scenarioId}/logs`, { params });
    return response.data;
  }

  async cloneScenario(
    projectKey: string,
    sourceScenarioId: string,
    newScenarioName: string,
    modifications?: Record<string, any>
  ): Promise<any> {
    const data = {
      sourceScenarioId,
      newScenarioName,
      modifications: modifications || {},
    };
    const response = await this.client.post(`/projects/${projectKey}/scenarios/clone`, data);
    return response.data;
  }

  // Job operations
  async getJobs(projectKey: string, limit: number = 50, statusFilter?: string): Promise<any[]> {
    const params: Record<string, any> = { limit };
    if (statusFilter) {
      params.status = statusFilter;
    }
    const response = await this.client.get(`/projects/${projectKey}/jobs/`, { params });
    return response.data;
  }

  async getJobDetails(projectKey: string, jobId: string) {
    return new JobService(this.client, this.config.apiKey).details({ project_key: projectKey, job_id: jobId });
  }

  async getJobStatus(request: JobRequest) {
    return new JobService(this.client, this.config.apiKey).status(request);
  }

  async waitForJob(request: JobRequest & { timeout_seconds?: number }) {
    return new JobService(this.client, this.config.apiKey).wait(request);
  }

  async getJobLog(request: JobRequest & { activity_id?: string; max_chars?: number }) {
    return new JobService(this.client, this.config.apiKey).log(request);
  }

  async cancelJob(projectKey: string, jobId: string): Promise<any> {
    const response = await this.client.post(`/projects/${projectKey}/jobs/${jobId}/abort`);
    return response.data;
  }

  // Project exploration
  async searchProjectObjects(projectKey: string, searchTerm: string, objectTypes?: string[]): Promise<any[]> {
    const params: Record<string, any> = { searchTerm };
    if (objectTypes) {
      params.objectTypes = objectTypes.join(',');
    }
    const response = await this.client.get(`/projects/${projectKey}/search/`, { params });
    return response.data;
  }

  // Productivity tools
  async duplicateProjectStructure(sourceProjectKey: string, targetProjectKey: string, includeData: boolean = false): Promise<any> {
    const data = {
      sourceProjectKey,
      targetProjectKey,
      includeData,
    };
    const response = await this.client.post('/admin/projects/duplicate', data);
    return response.data;
  }

  async exportProjectConfig(projectKey: string, format: 'json' | 'yaml' = 'json'): Promise<any> {
    if (format !== 'json') throw new Error('Structured Flow configuration export supports JSON only; YAML/archive export is not provided by this read-only tool');
    return { format: 'json', export_kind: 'flow_configuration_snapshot', archive_included: false,
      configuration: await this.getProjectFlow(projectKey) };

  }

  async batchUpdateObjects(projectKey: string, objectType: string, pattern: string, updates: Record<string, any>): Promise<any> {
    const data = {
      objectType,
      pattern,
      updates,
    };
    const response = await this.client.post(`/projects/${projectKey}/batch-update`, data);
    return response.data;
  }

  // Environment configuration
  async getCodeEnvironments(projectKey?: string): Promise<any[]> {
    const endpoint = projectKey
      ? `/projects/${projectKey}/code-envs/`
      : '/admin/code-envs/';
    const response = await this.client.get(endpoint);
    return Array.isArray(response.data) ? response.data : [response.data];
  }

  async getProjectVariables(projectKey: string): Promise<any> {
    const response = await this.client.get(`/projects/${projectKey}/variables/`);
    return response.data;
  }

  async getConnections(projectKey?: string): Promise<any[]> {
    const endpoint = projectKey
      ? `/projects/${projectKey}/connections/`
      : '/admin/connections/';
    const response = await this.client.get(endpoint);
    return Array.isArray(response.data) ? response.data : [response.data];
  }
}

