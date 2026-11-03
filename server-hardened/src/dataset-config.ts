import { zoneFields, exclusiveZone } from './flow-zone.js';
import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/).max(255);
const text = z.string().trim().min(1);
export const storageFields = {
  dataset_type: z.enum(['Filesystem', 'S3']).optional(),
  managed: z.boolean().optional(), connection: text.optional(), path: text.optional(), bucket: text.optional(),
  format_type: text.optional(), format_params: z.record(z.string(), z.unknown()).optional(),
  schema: z.strictObject({ columns: z.array(z.strictObject({ name: text,
    type: z.enum(['string', 'boolean', 'tinyint', 'smallint', 'int', 'bigint', 'float', 'double', 'date', 'dateonly', 'datetimenotz', 'array', 'map', 'object']),
    meaning: text.optional(),
  })).min(1) }).optional(),
  clone_settings_from: identifier.optional(),
};
export const createDatasetSchema = z.strictObject({ project_key: identifier, dataset_name: identifier,
  ...storageFields, ...zoneFields, dry_run: z.boolean().default(true) }).refine(exclusiveZone, 'Use only zone_id or zone_name');
export const recipeOutputSchema = z.strictObject({ name: identifier, new: z.boolean().optional(), ...storageFields });
export const datasetSchema = storageFields.schema.unwrap().refine(value => new Set(value.columns.map(c => c.name)).size === value.columns.length, 'Duplicate column names are not permitted');
export const updateDatasetSchema = z.strictObject({ project_key: identifier, dataset_name: identifier,
  schema: datasetSchema.optional(), dry_run: z.boolean().default(false) });
export const applyDatasetSchema = updateDatasetSchema.extend({ schema: datasetSchema });
export type UpdateDatasetRequest = z.input<typeof updateDatasetSchema>;
export type CreateDatasetRequest = z.input<typeof createDatasetSchema>;
export type DatasetRequest = z.output<typeof createDatasetSchema>;
