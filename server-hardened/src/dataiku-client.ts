type QueryValue = string | number | boolean | undefined;
type RequestOptions = { params?: Record<string, QueryValue> };

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

class SecureHttpClient {
  constructor(
    private readonly baseUrl: URL,
    private readonly apiKey: string,
  ) {}

  private async request(
    method: string,
    relativePath: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<{ data: any }> {
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
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
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

    if (response.status === 401) throw new Error('Invalid Dataiku API key');
    if (response.status === 403) throw new Error('Insufficient permissions for Dataiku operation');
    if (response.status === 404) throw new Error('Dataiku resource not found');
    if (!response.ok) throw new Error(`Dataiku API request failed with status ${response.status}`);

    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_RESPONSE_BYTES) {
      throw new Error('Dataiku API response exceeded the configured size limit');
    }

    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new Error('Dataiku API response exceeded the configured size limit');
    }
    return { data: text.length === 0 ? null : JSON.parse(text) };
  }

  get(path: string, options?: RequestOptions) {
    return this.request('GET', path, undefined, options);
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
  outputs: Array<{
    name: string;
    new?: boolean;
    connection?: string;
  }>;
  code?: string;
  params?: Record<string, any>;
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

    this.client = new SecureHttpClient(host, this.config.apiKey);
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

  async getProjectFlow(projectKey: string): Promise<any> {
    const response = await this.client.get(`/projects/${projectKey}/flow/`);
    return response.data;
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

  async createDataset(projectKey: string, datasetName: string, datasetType: string, params: Record<string, any>): Promise<any> {
    const data = {
      name: datasetName,
      type: datasetType,
      params,
    };
    const response = await this.client.post(`/projects/${projectKey}/datasets/`, data);
    return response.data;
  }

  async updateDataset(projectKey: string, datasetName: string, updates: Record<string, any>): Promise<any> {
    const response = await this.client.put(`/projects/${projectKey}/datasets/${datasetName}`, updates);
    return response.data;
  }

  async deleteDataset(projectKey: string, datasetName: string, dropData: boolean = false): Promise<any> {
    const response = await this.client.delete(`/projects/${projectKey}/datasets/${datasetName}`, {
      params: { dropData },
    });
    return response.data;
  }

  async buildDataset(projectKey: string, datasetName: string, options: { mode?: string; partition?: string } = {}): Promise<any> {
    const data = {
      type: 'RECURSIVE_BUILD',
      ...options,
    };
    const response = await this.client.post(`/projects/${projectKey}/datasets/${datasetName}/actions/build`, data);
    return response.data;
  }

  async getDatasetSchema(projectKey: string, datasetName: string): Promise<DatasetSchema> {
    const response = await this.client.get(`/projects/${projectKey}/datasets/${datasetName}/schema`);
    return response.data;
  }

  async getDatasetMetrics(projectKey: string, datasetName: string): Promise<DatasetMetrics> {
    const response = await this.client.get(`/projects/${projectKey}/datasets/${datasetName}/metrics`);
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
    const params: Record<string, any> = { rows };
    if (columns) {
      params.columns = columns.join(',');
    }
    const response = await this.client.get(`/projects/${projectKey}/datasets/${datasetName}/sample`, { params });
    return response.data;
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
    const response = await this.client.get(`/projects/${projectKey}/recipes/${recipeName}/info`);
    return response.data;
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
    const data = {
      name: recipe.name,
      type: recipe.type,
      inputs: { main: { items: recipe.inputs.map(input => ({ ref: input })) } },
      outputs: { main: { items: recipe.outputs.map(output => ({ ref: output.name, appendMode: false })) } },
      script: recipe.params,
    };

    if (recipe.code) {
      data.script = { ...data.script, code: recipe.code };
    }

    const response = await this.client.post(`/projects/${projectKey}/recipes/`, data);
    return response.data;
  }

  async updateRecipe(projectKey: string, recipeName: string, updates: Record<string, any>): Promise<any> {
    const response = await this.client.put(`/projects/${projectKey}/recipes/${recipeName}`, updates);
    return response.data;
  }

  async deleteRecipe(projectKey: string, recipeName: string): Promise<any> {
    const response = await this.client.delete(`/projects/${projectKey}/recipes/${recipeName}`);
    return response.data;
  }

  async runRecipe(projectKey: string, recipeName: string, buildMode?: string): Promise<any> {
    const data = {
      type: buildMode || 'RECURSIVE_BUILD',
    };
    const response = await this.client.post(`/projects/${projectKey}/recipes/${recipeName}/actions/build`, data);
    return response.data;
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

  async getJobDetails(projectKey: string, jobId: string): Promise<JobInfo> {
    const response = await this.client.get(`/projects/${projectKey}/jobs/${jobId}`);
    return response.data;
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
    const params = { format };
    const response = await this.client.get(`/projects/${projectKey}/export`, { params });
    return response.data;
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

