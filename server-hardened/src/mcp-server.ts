#!/usr/bin/env node
import { listZonesSchema, objectZoneSchema, moveFlowSchema, flowSchema } from './flow-zone.js';
import { replaceInputSchema } from './input-replacement.js';
import { sampleRequestSchema } from './dataset-sample.js';
import { buildDatasetSchema, runRecipeSchema, jobStatusSchema, waitForJobSchema, jobLogSchema } from './job-service.js';
import { createDatasetSchema, updateDatasetSchema, applyDatasetSchema } from './dataset-config.js';
import { errorDetails, sanitize } from './dss-error.js';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { DataikuClient } from './dataiku-client.js';
import { z } from 'zod';
import { createRecipeSchema, updateRecipeSchema, repairRecipeSchema, type RecipeConfig } from './recipe-config.js';

/**
 * MCP Server for Dataiku DSS integration
 */
export class DataikuMcpServer {
  private server: Server;
  private client: DataikuClient;

  constructor() {
    this.server = new Server(
      {
        name: 'dataiku-dss-mcp',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.client = new DataikuClient();
    this.setupHandlers();
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          { name: 'replace_visual_recipe_input', description: 'Replace one schema-identical visual input in-place while preserving native mappings and transformations. Defaults to GET-only dry-run. No schema writes or builds.', inputSchema: z.toJSONSchema(replaceInputSchema, { io: 'input' }) as Tool['inputSchema'] },
          { name: 'list_flow_zones', description: 'Read official DSS Flow zones, IDs, default status and owned object counts.', inputSchema: z.toJSONSchema(listZonesSchema, { io: 'input' }) as Tool['inputSchema'] },
          { name: 'get_flow_object_zone', description: 'Verify a typed Flow object exists and return its owning zone.', inputSchema: z.toJSONSchema(objectZoneSchema, { io: 'input' }) as Tool['inputSchema'] },
          { name: 'move_flow_items', description: 'Batch move Flow ownership. Defaults GET-only dry-run. Preflight all references and related recipe/outputs; actual mode verifies assignment and compensates failures.', inputSchema: z.toJSONSchema(moveFlowSchema, { io: 'input' }) as Tool['inputSchema'] },
          // Recipe Management Tools
          {
            name: 'create_recipe',
            description: 'Create code, visual, or Prompt recipes using existing unowned outputs. dry_run=true performs GET-only preflight. Prompt validates referenced input columns and saves a native DSS payload without invoking the LLM. Never builds data.',
            inputSchema: z.toJSONSchema(createRecipeSchema, { io: 'input' }) as Tool['inputSchema'],
          },
          {
            name: 'update_recipe',
            description: 'Update code or replace typed visual/Prompt configuration, preserving other settings. dry_run=true returns the proposed settings without saving. Never builds data or invokes an LLM.',
            inputSchema: z.toJSONSchema(updateRecipeSchema, { io: 'input' }) as Tool['inputSchema'],
          },
          {
            name: 'delete_recipe',
            description: 'Delete a recipe from a project',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                recipe_name: {
                  type: 'string',
                  description: 'Name of the recipe to delete',
                },
              },
              required: ['project_key', 'recipe_name'],
            },
          },
          {
            name: 'repair_recipe_configuration',
            description: 'Repair existing visual or Prompt recipe payload with complete typed config; preserves I/O and schema, never builds or invokes an LLM.',
            inputSchema: z.toJSONSchema(repairRecipeSchema, { io: 'input' }) as Tool['inputSchema'],
          },
          {
            name: 'run_recipe',
            description: 'Build the unique recipe output via a DSS job. Defaults non-recursive and async. dry_run is GET-only.',
            inputSchema: z.toJSONSchema(runRecipeSchema, { io: 'input' }) as Tool['inputSchema'],
          },
          { name: 'get_job_status', description: 'Read job state and sanitized failure diagnostics.', inputSchema: z.toJSONSchema(jobStatusSchema, { io: 'input' }) as Tool['inputSchema'] },
          { name: 'wait_for_job', description: 'Wait for a job; timeout does not cancel or resubmit it.', inputSchema: z.toJSONSchema(waitForJobSchema, { io: 'input' }) as Tool['inputSchema'] },
          { name: 'get_job_log', description: 'Get a bounded sanitized job or activity log excerpt.', inputSchema: z.toJSONSchema(jobLogSchema, { io: 'input' }) as Tool['inputSchema'] },
          // Dataset Management Tools
          {
            name: 'create_dataset',
            description: 'Provision a managed S3/Filesystem dataset, optionally cloning storage settings. dry_run performs GET-only validation.',
            inputSchema: z.toJSONSchema(createDatasetSchema, { io: 'input' }) as Tool['inputSchema'],
          },
          {
            name: 'update_dataset',
            description: 'Replace only an explicitly supplied dataset schema; preserve storage, metadata and producer. dry_run is GET-only; never builds.',
            inputSchema: z.toJSONSchema(updateDatasetSchema, { io: 'input' }) as Tool['inputSchema'],
          },
          {
            name: 'apply_dataset_schema',
            description: 'Apply an explicit dataset schema with preflight, diff and read-back verification; never build or delete data.',
            inputSchema: z.toJSONSchema(applyDatasetSchema, { io: 'input' }) as Tool['inputSchema'],
          },
          {
            name: 'delete_dataset',
            description: 'Delete a dataset from a project',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                dataset_name: {
                  type: 'string',
                  description: 'Name of the dataset to delete',
                },
                drop_data: {
                  type: 'boolean',
                  description: 'Whether to drop the underlying data',
                },
              },
              required: ['project_key', 'dataset_name'],
            },
          },
          {
            name: 'build_dataset',
            description: 'Build an existing produced dataset via a DSS job. Defaults non-recursive and async. dry_run is GET-only.',
            inputSchema: z.toJSONSchema(buildDatasetSchema, { io: 'input' }) as Tool['inputSchema'],
          },
          {
            name: 'inspect_dataset_schema',
            description: 'Get dataset schema information',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                dataset_name: {
                  type: 'string',
                  description: 'Name of the dataset',
                },
              },
              required: ['project_key', 'dataset_name'],
            },
          },
          {
            name: 'check_dataset_metrics',
            description: 'Get latest dataset metrics',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                dataset_name: {
                  type: 'string',
                  description: 'Name of the dataset',
                },
              },
              required: ['project_key', 'dataset_name'],
            },
          },
          // Scenario Management Tools
          {
            name: 'create_scenario',
            description: 'Create a new scenario in a project',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                scenario_name: {
                  type: 'string',
                  description: 'Name for the new scenario',
                },
                scenario_type: {
                  type: 'string',
                  description: 'Type of scenario (step_based or custom_python)',
                },
                definition: {
                  type: 'object',
                  description: 'Optional scenario definition',
                },
              },
              required: ['project_key', 'scenario_name', 'scenario_type'],
            },
          },
          {
            name: 'update_scenario',
            description: 'Update scenario settings',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                scenario_id: {
                  type: 'string',
                  description: 'ID of the scenario to update',
                },
              },
              required: ['project_key', 'scenario_id'],
            },
          },
          {
            name: 'delete_scenario',
            description: 'Delete a scenario from a project',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                scenario_id: {
                  type: 'string',
                  description: 'ID of the scenario to delete',
                },
              },
              required: ['project_key', 'scenario_id'],
            },
          },
          {
            name: 'run_scenario',
            description: 'Run a scenario manually',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                scenario_id: {
                  type: 'string',
                  description: 'ID of the scenario to run',
                },
              },
              required: ['project_key', 'scenario_id'],
            },
          },
          // Advanced Tools
          {
            name: 'get_scenario_logs',
            description: 'Get detailed run logs and error messages for failed scenarios',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                scenario_id: {
                  type: 'string',
                  description: 'ID of the scenario',
                },
                run_id: {
                  type: 'string',
                  description: 'Specific run ID (defaults to latest)',
                },
              },
              required: ['project_key', 'scenario_id'],
            },
          },
          {
            name: 'get_recipe_code',
            description: 'Extract actual Python/SQL code from recipes',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                recipe_name: {
                  type: 'string',
                  description: 'Name of the recipe',
                },
              },
              required: ['project_key', 'recipe_name'],
            },
          },
          {
            name: 'get_project_flow',
            description: 'Read official Flow graph with typed objects, dependency edges and zone assignments; bounded summary/detail.',
            inputSchema: z.toJSONSchema(flowSchema, { io: 'input' }) as Tool['inputSchema'],
          },
          {
            name: 'get_dataset_sample',
            description: 'Read bounded HEAD rows via official DSS data stream (1–1000 rows, 1 MiB). Validate columns before reading; values remain strings.',
            inputSchema: z.toJSONSchema(sampleRequestSchema, { io: 'input' }) as Tool['inputSchema'],
          },
          {
            name: 'get_recent_runs',
            description: 'Get recent run history across all scenarios/recipes',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                limit: {
                  type: 'number',
                  description: 'Number of recent runs to retrieve',
                  default: 50,
                },
                status_filter: {
                  type: 'string',
                  description: 'Filter by status',
                },
              },
              required: ['project_key'],
            },
          },
          {
            name: 'list_projects',
            description: 'List all available Dataiku projects',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          // Additional Dataset Tools
          {
            name: 'list_datasets',
            description: 'List all datasets in a project',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                dataset_type: {
                  type: 'string',
                  description: 'Optional filter by dataset type',
                },
                search: {
                  type: 'string',
                  description: 'Optional search keyword to filter datasets by name',
                },
                simple: {
                  type: 'boolean',
                  description: 'Whether to return only simplified dataset information (name, projectKey, type)',
                  default: false,
                },
              },
              required: ['project_key'],
            },
          },
          {
            name: 'get_dataset_info',
            description: 'Get detailed information about a dataset',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                dataset_name: {
                  type: 'string',
                  description: 'Name of the dataset',
                },
              },
              required: ['project_key', 'dataset_name'],
            },
          },
          {
            name: 'clear_dataset',
            description: 'Clear data from a dataset',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                dataset_name: {
                  type: 'string',
                  description: 'Name of the dataset to clear',
                },
                partition: {
                  type: 'string',
                  description: 'Optional partition to clear',
                },
              },
              required: ['project_key', 'dataset_name'],
            },
          },
          // Additional Recipe Tools
          {
            name: 'list_recipes',
            description: 'List all recipes in a project',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                recipe_type: {
                  type: 'string',
                  description: 'Optional filter by recipe type',
                },
                search: {
                  type: 'string',
                  description: 'Optional search keyword to filter recipes by name',
                },
                simple: {
                  type: 'boolean',
                  description: 'Whether to return only simplified recipe information (name, projectKey, type)',
                  default: false,
                },
              },
              required: ['project_key'],
            },
          },
          {
            name: 'get_recipe_info',
            description: 'Get detailed information about a recipe',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                recipe_name: {
                  type: 'string',
                  description: 'Name of the recipe',
                },
              },
              required: ['project_key', 'recipe_name'],
            },
          },
          {
            name: 'validate_recipe_syntax',
            description: 'Validate Python/SQL syntax of a recipe',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                recipe_name: {
                  type: 'string',
                  description: 'Name of the recipe',
                },
                code: {
                  type: 'string',
                  description: 'Optional code to validate (uses recipe code if not provided)',
                },
              },
              required: ['project_key', 'recipe_name'],
            },
          },
          {
            name: 'test_recipe_dry_run',
            description: 'Test recipe logic without actual execution',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                recipe_name: {
                  type: 'string',
                  description: 'Name of the recipe',
                },
                sample_rows: {
                  type: 'number',
                  description: 'Number of sample rows to test with',
                  default: 100,
                },
              },
              required: ['project_key', 'recipe_name'],
            },
          },
          // Additional Scenario Tools
          {
            name: 'list_scenarios',
            description: 'List all scenarios in a project',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                scenario_type: {
                  type: 'string',
                  description: 'Optional filter by scenario type',
                },
                active_only: {
                  type: 'boolean',
                  description: 'Whether to list only active scenarios',
                  default: false,
                },
              },
              required: ['project_key'],
            },
          },
          {
            name: 'get_scenario_info',
            description: 'Get detailed information about a scenario',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                scenario_id: {
                  type: 'string',
                  description: 'ID of the scenario',
                },
              },
              required: ['project_key', 'scenario_id'],
            },
          },
          {
            name: 'add_scenario_trigger',
            description: 'Add a trigger to a scenario',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                scenario_id: {
                  type: 'string',
                  description: 'ID of the scenario',
                },
                trigger_type: {
                  type: 'string',
                  description: 'Type of trigger (periodic, hourly, daily, monthly, dataset)',
                },
                every_minutes: {
                  type: 'number',
                  description: 'For periodic triggers: interval in minutes',
                },
                hour: {
                  type: 'number',
                  description: 'For time-based triggers: hour (0-23)',
                },
                minute: {
                  type: 'number',
                  description: 'For time-based triggers: minute (0-59)',
                },
                dataset_name: {
                  type: 'string',
                  description: 'For dataset triggers: name of the dataset',
                },
                timezone: {
                  type: 'string',
                  description: 'Timezone for time-based triggers',
                  default: 'SERVER',
                },
              },
              required: ['project_key', 'scenario_id', 'trigger_type'],
            },
          },
          {
            name: 'remove_scenario_trigger',
            description: 'Remove a trigger from a scenario',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                scenario_id: {
                  type: 'string',
                  description: 'ID of the scenario',
                },
                trigger_idx: {
                  type: 'number',
                  description: 'Index of the trigger to remove (0-based)',
                },
              },
              required: ['project_key', 'scenario_id', 'trigger_idx'],
            },
          },
          {
            name: 'get_scenario_run_history',
            description: 'Get run history for a scenario',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                scenario_id: {
                  type: 'string',
                  description: 'ID of the scenario',
                },
                limit: {
                  type: 'number',
                  description: 'Maximum number of runs to return',
                  default: 10,
                },
              },
              required: ['project_key', 'scenario_id'],
            },
          },
          {
            name: 'get_scenario_steps',
            description: 'Get step configuration including Python code',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                scenario_id: {
                  type: 'string',
                  description: 'ID of the scenario',
                },
              },
              required: ['project_key', 'scenario_id'],
            },
          },
          {
            name: 'clone_scenario',
            description: 'Clone an existing scenario with modifications',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                source_scenario_id: {
                  type: 'string',
                  description: 'Source scenario ID to clone',
                },
                new_scenario_name: {
                  type: 'string',
                  description: 'Name for the new scenario',
                },
                modifications: {
                  type: 'object',
                  description: 'Optional modifications to apply',
                },
              },
              required: ['project_key', 'source_scenario_id', 'new_scenario_name'],
            },
          },
          // Advanced Tools
          {
            name: 'search_project_objects',
            description: 'Search for datasets, recipes, scenarios by name/pattern',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                search_term: {
                  type: 'string',
                  description: 'Search pattern',
                },
                object_types: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'List of object types to search (datasets, recipes, scenarios)',
                },
              },
              required: ['project_key', 'search_term'],
            },
          },
          {
            name: 'get_code_environments',
            description: 'List available Python/R environments',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'Project identifier (optional)',
                },
              },
            },
          },
          {
            name: 'get_project_variables',
            description: 'Get project-level variables and configuration',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
              },
              required: ['project_key'],
            },
          },
          {
            name: 'get_connections',
            description: 'List available data connections',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'Project identifier (optional)',
                },
              },
            },
          },
          {
            name: 'get_job_details',
            description: 'Get detailed job execution information',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                job_id: {
                  type: 'string',
                  description: 'Job identifier',
                },
              },
              required: ['project_key', 'job_id'],
            },
          },
          {
            name: 'cancel_running_jobs',
            description: 'Cancel running jobs/scenarios',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                job_ids: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'List of job IDs to cancel',
                },
              },
              required: ['project_key', 'job_ids'],
            },
          },
          {
            name: 'batch_update_objects',
            description: 'Update multiple objects with similar changes',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                object_type: {
                  type: 'string',
                  description: 'Type of objects to update',
                },
                pattern: {
                  type: 'string',
                  description: 'Pattern to match objects',
                },
                updates: {
                  type: 'object',
                  description: 'Updates to apply',
                },
              },
              required: ['project_key', 'object_type', 'pattern', 'updates'],
            },
          },
          {
            name: 'export_project_config',
            description: 'Read a structured JSON Flow configuration snapshot (zones, objects, dependencies); not a full project archive.',
            inputSchema: {
              type: 'object',
              properties: {
                project_key: {
                  type: 'string',
                  description: 'The project key',
                },
                format: {
                  type: 'string',
                  description: 'Only json is supported; binary project archives are never returned as text.',
                  enum: ['json'],
                  default: 'json',
                },
              },
              required: ['project_key'],
            },
          },
          {
            name: 'duplicate_project_structure',
            description: 'Copy project structure to new project',
            inputSchema: {
              type: 'object',
              properties: {
                source_project_key: {
                  type: 'string',
                  description: 'Source project identifier',
                },
                target_project_key: {
                  type: 'string',
                  description: 'Target project identifier',
                },
                include_data: {
                  type: 'boolean',
                  description: 'Whether to copy data',
                  default: false,
                },
              },
              required: ['source_project_key', 'target_project_key'],
            },
          },
        ] as Tool[],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        if (!args) {
          throw new Error('Tool arguments are required');
        }

        let result: any;

        switch (name) {
          // Recipe Management
          case 'create_recipe':
            createRecipeSchema.parse(args);
            result = await this.client.createRecipe(String(args.project_key), {
              name: String(args.recipe_name),
              type: String(args.recipe_type),
              inputs: args.inputs as string[],
              outputs: args.outputs as Array<{name: string; new?: boolean; connection?: string}>,
              code: args.code as string | undefined,
              config: args.config as RecipeConfig | undefined,
              dry_run: args.dry_run as boolean | undefined,
              zone_id: args.zone_id as string | undefined, zone_name: args.zone_name as string | undefined,
              move_existing_outputs: args.move_existing_outputs as boolean | undefined,
            });
            break;

          case 'replace_visual_recipe_input':
            result = await this.client.replaceVisualRecipeInput(replaceInputSchema.parse(args));
            break;

          case 'update_recipe':
            const { project_key: updateProjectKey, recipe_name: updateRecipeName, ...recipeUpdates } = args;
            result = await this.client.updateRecipe(String(updateProjectKey), String(updateRecipeName), recipeUpdates);
            break;

          case 'delete_recipe':
            result = await this.client.deleteRecipe(String(args.project_key), String(args.recipe_name));
            break;

          case 'repair_recipe_configuration':
            result = await this.client.repairRecipeConfiguration(repairRecipeSchema.parse(args));
            break;

          case 'run_recipe':
            result = await this.client.runRecipe(runRecipeSchema.parse(args));
            break;

          // Dataset Management
          case 'create_dataset':
            result = await this.client.createDataset(createDatasetSchema.parse(args));
            break;

          case 'update_dataset':
            result = await this.client.updateDataset(updateDatasetSchema.parse(args));
            break;

          case 'apply_dataset_schema':
            result = await this.client.updateDataset(applyDatasetSchema.parse(args));
            break;

          case 'delete_dataset':
            result = await this.client.deleteDataset(String(args.project_key), String(args.dataset_name), Boolean(args.drop_data));
            break;

          case 'build_dataset':
            result = await this.client.buildDataset(buildDatasetSchema.parse(args));
            break;

          case 'inspect_dataset_schema':
            result = await this.client.getDatasetSchema(String(args.project_key), String(args.dataset_name));
            break;

          case 'check_dataset_metrics':
            result = await this.client.getDatasetMetrics(String(args.project_key), String(args.dataset_name));
            break;

          // Scenario Management
          case 'create_scenario':
            result = await this.client.createScenario(String(args.project_key), {
              name: String(args.scenario_name),
              type: args.scenario_type as 'step_based' | 'custom_python',
              definition: args.definition as Record<string, any>,
            });
            break;

          case 'update_scenario':
            const { project_key: updateScenarioProjectKey, scenario_id, ...scenarioUpdates } = args;
            result = await this.client.updateScenario(String(updateScenarioProjectKey), String(scenario_id), scenarioUpdates);
            break;

          case 'delete_scenario':
            result = await this.client.deleteScenario(String(args.project_key), String(args.scenario_id));
            break;

          case 'run_scenario':
            result = await this.client.runScenario(String(args.project_key), String(args.scenario_id));
            break;

          // Advanced Tools
          case 'get_scenario_logs':
            result = await this.client.getScenarioLogs(String(args.project_key), String(args.scenario_id), args.run_id as string);
            break;

          case 'get_recipe_code':
            const recipe = await this.client.getRecipe(String(args.project_key), String(args.recipe_name));
            result = {
              name: String(args.recipe_name),
              type: recipe.type,
              code: recipe.script?.code || recipe.params?.code || 'No code available',
            };
            break;

          case 'list_flow_zones':
            result = await this.client.listFlowZones(args); break;
          case 'get_flow_object_zone':
            result = await this.client.getFlowObjectZone(args); break;
          case 'move_flow_items':
            result = await this.client.moveFlowItems(args); break;
          case 'get_project_flow':
            result = await this.client.getProjectFlow(String(args.project_key), { detail: args.detail, max_objects: args.max_objects });
            break;

          case 'get_dataset_sample':
            result = await this.client.getDatasetSample(
              String(args.project_key),
              String(args.dataset_name),
              args.rows === undefined ? 100 : args.rows as number,
              args.columns as string[]
            );
            break;

          case 'get_recent_runs':
            result = await this.client.getJobs(String(args.project_key), Number(args.limit) || 50, args.status_filter as string);
            break;

          case 'list_projects':
            result = await this.client.listProjects();
            break;

          // Additional Dataset Tools
          case 'list_datasets':
            let datasets = await this.client.listDatasets(String(args.project_key));

            // Apply search filter if provided
            if (args.search) {
              const searchTerm = String(args.search).toLowerCase();
              datasets = datasets.filter((dataset: any) =>
                dataset.name?.toLowerCase().includes(searchTerm)
              );
            }

            // Apply simple mode if requested
            if (args.simple) {
              datasets = datasets.map((dataset: any) => ({
                name: dataset.name,
                projectKey: dataset.projectKey,
                type: dataset.type,
              }));
            }

            result = datasets;
            break;

          case 'get_dataset_info':
            result = await this.client.getDatasetInfo(String(args.project_key), String(args.dataset_name));
            break;

          case 'clear_dataset':
            result = await this.client.clearDataset(String(args.project_key), String(args.dataset_name), args.partition as string);
            break;

          // Additional Recipe Tools
          case 'list_recipes':
            let recipes = await this.client.listRecipes(String(args.project_key));

            // Apply search filter if provided
            if (args.search) {
              const searchTerm = String(args.search).toLowerCase();
              recipes = recipes.filter((recipe: any) =>
                recipe.name?.toLowerCase().includes(searchTerm)
              );
            }

            // Apply simple mode if requested
            if (args.simple) {
              recipes = recipes.map((recipe: any) => ({
                name: recipe.name,
                projectKey: recipe.projectKey,
                type: recipe.type,
              }));
            }

            result = recipes;
            break;

          case 'get_recipe_info':
            result = await this.client.getRecipeInfo(String(args.project_key), String(args.recipe_name));
            break;

          case 'validate_recipe_syntax':
            result = await this.client.validateRecipeSyntax(String(args.project_key), String(args.recipe_name), args.code as string);
            break;

          case 'test_recipe_dry_run':
            result = await this.client.testRecipeDryRun(String(args.project_key), String(args.recipe_name), Number(args.sample_rows) || 100);
            break;

          // Additional Scenario Tools
          case 'list_scenarios':
            result = await this.client.listScenarios(String(args.project_key));
            break;

          case 'get_scenario_info':
            result = await this.client.getScenarioInfo(String(args.project_key), String(args.scenario_id));
            break;

          case 'add_scenario_trigger':
            const triggerParams: Record<string, any> = {};
            if (args.every_minutes !== undefined) triggerParams.every_minutes = args.every_minutes;
            if (args.hour !== undefined) triggerParams.hour = args.hour;
            if (args.minute !== undefined) triggerParams.minute = args.minute;
            if (args.dataset_name !== undefined) triggerParams.dataset_name = args.dataset_name;
            if (args.timezone !== undefined) triggerParams.timezone = args.timezone;

            result = await this.client.addScenarioTrigger(
              String(args.project_key),
              String(args.scenario_id),
              args.trigger_type as 'periodic' | 'hourly' | 'daily' | 'monthly' | 'dataset',
              triggerParams
            );
            break;

          case 'remove_scenario_trigger':
            result = await this.client.removeScenarioTrigger(String(args.project_key), String(args.scenario_id), Number(args.trigger_idx));
            break;

          case 'get_scenario_run_history':
            result = await this.client.getScenarioRunHistory(String(args.project_key), String(args.scenario_id), Number(args.limit) || 10);
            break;

          case 'get_scenario_steps':
            result = await this.client.getScenarioSteps(String(args.project_key), String(args.scenario_id));
            break;

          case 'clone_scenario':
            result = await this.client.cloneScenario(
              String(args.project_key),
              String(args.source_scenario_id),
              String(args.new_scenario_name),
              args.modifications as Record<string, any>
            );
            break;

          // Advanced Tools
          case 'search_project_objects':
            result = await this.client.searchProjectObjects(
              String(args.project_key),
              String(args.search_term),
              args.object_types as string[]
            );
            break;

          case 'get_code_environments':
            result = await this.client.getCodeEnvironments(args.project_key as string);
            break;

          case 'get_project_variables':
            result = await this.client.getProjectVariables(String(args.project_key));
            break;

          case 'get_connections':
            result = await this.client.getConnections(args.project_key as string);
            break;

          case 'get_job_status':
            result = await this.client.getJobStatus(jobStatusSchema.parse(args));
            break;
          case 'wait_for_job':
            result = await this.client.waitForJob(waitForJobSchema.parse(args));
            break;
          case 'get_job_log':
            result = await this.client.getJobLog(jobLogSchema.parse(args));
            break;

          case 'get_job_details':
            result = await this.client.getJobDetails(String(args.project_key), String(args.job_id));
            break;

          case 'cancel_running_jobs':
            const jobIds = args.job_ids as string[];
            result = await this.client.cancelJob(String(args.project_key), String(jobIds[0]));
            break;

          case 'batch_update_objects':
            result = await this.client.batchUpdateObjects(
              String(args.project_key),
              String(args.object_type),
              String(args.pattern),
              args.updates as Record<string, any>
            );
            break;

          case 'export_project_config':
            result = await this.client.exportProjectConfig(String(args.project_key), (args.format as 'json' | 'yaml') || 'json');
            break;

          case 'duplicate_project_structure':
            result = await this.client.duplicateProjectStructure(
              String(args.source_project_key),
              String(args.target_project_key),
              Boolean(args.include_data)
            );
            break;

          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(sanitize(result, process.env.DSS_API_KEY ?? ''), null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(sanitize(errorDetails(error), process.env.DSS_API_KEY ?? ''), null, 2),
            },
          ],
          isError: true,
        };
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Dataiku DSS MCP Server running on stdio');
  }
}

// Start the server
const server = new DataikuMcpServer();
server.run().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
