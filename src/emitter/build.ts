import type { INestApplicationContext } from '@nestjs/common';
import { ModulesContainer, NestFactory } from '@nestjs/core';
import {
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  type BuildSchemaOptions,
} from '@nestjs/graphql';
import { GraphQLSchema } from 'graphql';
import type { SchemaConfig } from '../config/resolve';
import { harvest, scalarTargetType, ContainerLike } from './harvest';
import { serialize, SerializeOptions } from './serialize';
import { createPreviewContext } from './preview';

/**
 * `includeModules` is an *internal* schema-factory option:
 * `GraphQLSchemaBuilder.build` sets it on the object it hands to
 * `GraphQLSchemaFactory.create`, and `TypeDefinitionsGenerator.generate`
 * reads it back off — but it is absent from the public `BuildSchemaOptions`
 * declaration, which upstream works around with an untyped
 * `const internalOptions = options`. Naming it here keeps the forwarding
 * visible to the compiler rather than hiding the whole options object behind
 * an `any` cast.
 */
type InternalBuildSchemaOptions = BuildSchemaOptions & {
  includeModules?: Function[];
};

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
  // Preview mode: module graph is built, providers are never constructed.
  const previewCtx = await createPreviewContext(appModule);

  let sdl: string;
  let buildFailed = false;
  try {
    const container = previewCtx.get(ModulesContainer) as ContainerLike;
    const { resolvers, scalars } = harvest(container, opts.include);

    // A user-supplied `buildSchemaOptions.scalarsMap` entry wins over a
    // discovered `@Scalar()` provider for the same target type, exactly as in
    // `GraphQLSchemaBuilder.build`. The three-argument
    // `GraphQLSchemaFactory.create` overload appends discovered scalars to
    // `options.scalarsMap` with no such de-duplication, which would put two
    // `GraphQLScalarType`s of the same name into the schema's `types` array —
    // a hard "Schema must contain uniquely named types" failure the boot path
    // never hits.
    const discovered = dedupeAgainstUserScalars(scalars, opts.buildSchemaOptions);
    assertScalarsConstructibleWithoutInjection(discovered);

    const schemaCtx = await NestFactory.createApplicationContext(
      GraphQLSchemaBuilderModule,
      { logger: false },
    );
    let schemaFailed = false;
    try {
      const factory = schemaCtx.get(GraphQLSchemaFactory);
      const factoryOptions: InternalBuildSchemaOptions = {
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
      };
      const schema: GraphQLSchema = await factory.create(
        resolvers,
        discovered,
        factoryOptions,
      );
      sdl = await serialize(schema, {
        sortSchema: opts.sortSchema,
        addNewlineAtEnd: opts.addNewlineAtEnd,
        transformSchema: opts.transformAutoSchemaFile ? opts.transformSchema : undefined,
      });
    } catch (err) {
      schemaFailed = true;
      throw err;
    } finally {
      await closePreferringPrimaryError(schemaCtx, 'the schema-builder context', schemaFailed);
    }
  } catch (err) {
    buildFailed = true;
    throw err;
  } finally {
    await closePreferringPrimaryError(previewCtx, 'the preview context', buildFailed);
  }

  return sdl;
}

/**
 * Tear down a Nest context without letting its failure impersonate the cause.
 *
 * Both contexts are closed from a `finally`, so a `close()` that rejects while
 * an in-flight error is already unwinding would *replace* that error — the
 * real cause vanishes and the user is left debugging a teardown symptom. When
 * a primary error exists it wins; the close failure is reported on stderr so
 * it is still visible. With no primary error the close failure is the only
 * error there is, so it propagates normally.
 */
async function closePreferringPrimaryError(
  ctx: INestApplicationContext,
  label: string,
  unwindingFromPrimaryError: boolean,
): Promise<void> {
  try {
    await ctx.close();
  } catch (closeErr) {
    if (!unwindingFromPrimaryError) throw closeErr;
    const message = closeErr instanceof Error ? closeErr.message : String(closeErr);
    process.stderr.write(
      `[nest-graphql] warning: failed to close ${label} while unwinding from an earlier ` +
        `error. The original failure is being rethrown instead, so it is not masked by ` +
        `this teardown failure. Close error: ${message}\n`,
    );
  }
}

/**
 * Fail loudly on a `@Scalar()` provider that cannot be constructed with no
 * arguments, *before* handing it to `GraphQLSchemaFactory.create`.
 *
 * The boot path never constructs scalars itself: `ScalarsExplorerService`
 * reads already-DI-constructed provider *instances* out of the container and
 * calls `createScalarType(name, instance)` on them. The three-argument
 * `create` overload we use instead does `new classRef()` with no arguments
 * (`addScalarTypeByClassRef`), so a scalar whose constructor touches an
 * injected dependency throws — and upstream swallows that throw in a `catch`
 * whose only effect is `this.logger.error(...)`, which our `logger: false`
 * discards. The scalar is then simply absent from `scalarsMap`, and the
 * emitted SDL silently drops (or falls back to a different definition of) a
 * type the real boot emits. Byte parity is this package's whole correctness
 * guarantee, so a silent divergence is the worst possible outcome; a
 * pre-flight construction turns it into a named, actionable error.
 *
 * The construction is deliberately duplicated with upstream's — this is a
 * probe, and upstream will construct its own instance moments later.
 */
function assertScalarsConstructibleWithoutInjection(scalars: Function[]): void {
  for (const classRef of scalars) {
    try {
      new (classRef as new () => unknown)();
    } catch (err) {
      throw new Error(
        `The @Scalar() provider "${classRef.name}" cannot be constructed without its injected ` +
          `dependencies. Schema regeneration never instantiates providers, so this scalar cannot be ` +
          `registered and the emitted SDL would silently differ from a real boot. Move constructor ` +
          `logic into a lifecycle hook, or declare the scalar via buildSchemaOptions.scalarsMap. ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
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
