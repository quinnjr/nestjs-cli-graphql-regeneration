import { existsSync } from 'fs';
import * as path from 'path';

export const CONFIG_BASENAME = 'graphql.config.js';

export interface SchemaConfig {
  autoSchemaFile: string;
  sortSchema?: boolean;
  addNewlineAtEnd?: boolean;
  buildSchemaOptions?: Record<string, unknown>;
  transformSchema?: (schema: any) => any;
  include?: Function[];
}

export function resolveConfig(distRoot: string, schemaName: string): SchemaConfig {
  const candidates = [
    path.join(distRoot, CONFIG_BASENAME),
    path.join(distRoot, 'src', CONFIG_BASENAME),
  ];

  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new Error(
      `Could not find a compiled ${CONFIG_BASENAME}. Looked in:\n` +
        candidates.map((c) => `  - ${c}`).join('\n') +
        `\nRun "nest build" first, and export a "schemas" object from graphql.config.ts.`,
    );
  }

  const mod = require(found);
  const schemas = mod.schemas ?? mod.default?.schemas;
  if (!schemas) {
    throw new Error(`${found} does not export a "schemas" object.`);
  }

  const config = schemas[schemaName];
  if (!config) {
    throw new Error(
      `No schema named "${schemaName}" in ${found}. Available: ${Object.keys(schemas).join(', ')}`,
    );
  }

  return config;
}
