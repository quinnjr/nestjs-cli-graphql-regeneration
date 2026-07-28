import type { BuildSchemaOptions } from '@nestjs/graphql';
import { GraphQLSchema } from 'graphql';
import type { SchemaConfig } from '../config/resolve';
import { harvest, scalarTargetType, ContainerLike } from './harvest';
import { serialize, SerializeOptions } from './serialize';
import { createPreviewContext } from './preview';

export interface BuildSdlOptions extends SerializeOptions {
  buildSchemaOptions?: BuildSchemaOptions;
  include?: Function[];
  /**
   * Upstream only applies `transformSchema` to the `autoSchemaFile` output
   * when this is set — see `GraphQLSchemaBuilder.build`, which passes
   * `options.transformAutoSchemaFile && options.transformSchema` down as the
   * transform. It defaults falsy, so an app with a `transformSchema` for its
   * *served* schema and no `transformAutoSchemaFile` writes an
   * **untransformed** SDL file at boot.
   */
  transformAutoSchemaFile?: boolean;
}

/**
 * Translate a user's `graphql.config` entry into emitter options.
 *
 * The single place the `SchemaConfig` contract is interpreted, so that the
 * translation itself is testable — `test/parity-config.spec.ts` drives byte
 * parity through this function rather than through a copy of it.
 */
export function buildSdlOptionsFrom(config: SchemaConfig): BuildSdlOptions {
  return {
    sortSchema: config.sortSchema,
    // Upstream declares `addNewlineAtEnd` on `BuildSchemaOptions` and reads it
    // off the merged `buildSchemaOptions`, never at the top level. The nested
    // form is therefore authoritative; the top-level one survives only as a
    // legacy alias for configs written against this package's earlier,
    // incorrect reading. Getting this wrong is a one-byte diff — i.e. a
    // permanent false positive for a `git diff --exit-code` freshness check.
    addNewlineAtEnd: config.buildSchemaOptions?.addNewlineAtEnd ?? config.addNewlineAtEnd,
    transformSchema: config.transformSchema,
    transformAutoSchemaFile: config.transformAutoSchemaFile,
    buildSchemaOptions: config.buildSchemaOptions,
    include: config.include,
  };
}

export async function buildSdl(
  appModule: unknown,
  opts: BuildSdlOptions,
): Promise<string> {
  const { NestFactory, ModulesContainer } = require('@nestjs/core');
  const { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } = require('@nestjs/graphql');

  // Preview mode: module graph is built, providers are never constructed.
  const previewCtx = await createPreviewContext(appModule);

  let sdl: string;
  try {
    const container = previewCtx.get(ModulesContainer) as ContainerLike;
    const { resolvers, scalars } = harvest(container, opts.include);

    const schemaCtx = await NestFactory.createApplicationContext(
      GraphQLSchemaBuilderModule,
      { logger: false },
    );
    try {
      const factory = schemaCtx.get(GraphQLSchemaFactory);
      const schema: GraphQLSchema = await factory.create(
        resolvers,
        // A user-supplied `buildSchemaOptions.scalarsMap` entry wins over a
        // discovered `@Scalar()` provider for the same target type, exactly
        // as in `GraphQLSchemaBuilder.build`. The three-argument
        // `GraphQLSchemaFactory.create` overload appends discovered scalars
        // to `options.scalarsMap` with no such de-duplication, which would
        // put two `GraphQLScalarType`s of the same name into the schema's
        // `types` array — a hard "Schema must contain uniquely named types"
        // failure the boot path never hits.
        dedupeAgainstUserScalars(scalars, opts.buildSchemaOptions),
        {
          ...(opts.buildSchemaOptions ?? {}),
          // The outer spread copies the options object, but not the nested
          // `scalarsMap` array — a spread is shallow, so without this,
          // `scalarsMap` here would be the *same array instance* as the
          // caller's `opts.buildSchemaOptions.scalarsMap`.
          // `assignScalarObjects` (in `GraphQLSchemaFactory.create`) pushes
          // newly-discovered scalar entries onto whatever array it's handed,
          // so that shared reference would grow the caller's own array by
          // side effect — measured going from 1 entry to 2 on a caller's
          // object. Upstream (`GraphQLSchemaBuilder.build`) always builds a
          // fresh array for the same reason. Harmless in this one-shot child
          // process, but worth keeping honest.
          scalarsMap: opts.buildSchemaOptions?.scalarsMap
            ? [...opts.buildSchemaOptions.scalarsMap]
            : undefined,
          // Forwarded by `GraphQLSchemaBuilder.build`, and consumed by
          // `TypeDefinitionsGenerator.generate` to filter unions, enums,
          // interfaces, object types and input types by their `registerIn`
          // module. Omitting it made `include` filter resolvers but not
          // types, so orphaned-type emission diverged from the boot path.
          includeModules: opts.include,
        },
      );
      sdl = await serialize(schema, {
        sortSchema: opts.sortSchema,
        addNewlineAtEnd: opts.addNewlineAtEnd,
        transformSchema: opts.transformAutoSchemaFile ? opts.transformSchema : undefined,
      });
    } finally {
      await schemaCtx.close();
    }
  } finally {
    await previewCtx.close();
  }

  return sdl;
}

function dedupeAgainstUserScalars(
  scalars: Function[],
  buildSchemaOptions: BuildSchemaOptions | undefined,
): Function[] {
  const userScalars = buildSchemaOptions?.scalarsMap;
  if (!userScalars || userScalars.length === 0) return scalars;
  return scalars.filter((classRef) => {
    const target = scalarTargetType(classRef);
    return userScalars.every((item) => item.type !== target);
  });
}
