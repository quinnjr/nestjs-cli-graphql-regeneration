import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import {
  Field,
  GraphQLModule,
  ObjectType,
  Query,
  Resolver,
  Scalar,
  type GqlModuleOptions,
} from '@nestjs/graphql';
import { GraphQLObjectType, GraphQLScalarType, GraphQLSchema, GraphQLString } from 'graphql';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { buildSdl, buildSdlOptionsFrom } from '../src/emitter/build';
import { resolveOutFile, SCHEMA_CONFIG_FIELDS, SchemaConfig } from '../src/config/resolve';
import { RecipesResolver } from './fixtures/basic/recipes.resolver';

/**
 * THE CONTRACT TEST.
 *
 * `SchemaConfig` was originally written from a plan document rather than from
 * `@nestjs/graphql`'s own `GqlModuleOptions` / `BuildSchemaOptions`. Parity
 * was then proved only for the two fields one fixture happened to set, and
 * every field added afterwards inherited that gap: `autoSchemaFile` was typed
 * `string` when upstream accepts `boolean | string | SchemaFileConfig`,
 * `transformAutoSchemaFile` was missing entirely, `addNewlineAtEnd` was read
 * at the wrong nesting level, and `include` was a flat match where upstream
 * walks a transitive closure. None of it was visible to the compiler, because
 * a config loaded through `require()` arrives as `any`.
 *
 * So: for every field in `SchemaConfig`, boot a real app configured with that
 * field, let `autoSchemaFile` write the ground-truth SDL, and assert our
 * output is byte-identical. The `covers every field` test at the bottom fails
 * if a field is ever added without a case here, which moves ownership of the
 * contract from a document to this file.
 */

// ---------------------------------------------------------------------------
// Fixture graph
// ---------------------------------------------------------------------------

@ObjectType()
class Widget {
  @Field()
  name!: string;
}

@Resolver(() => Widget)
class WidgetsResolver {
  @Query(() => [Widget])
  widgets(): Widget[] {
    return [];
  }
}

/** Deliberately not referenced by any resolver — only reachable via `orphanedTypes`. */
@ObjectType()
class Ingredient {
  @Field()
  label!: string;
}

@Module({ providers: [WidgetsResolver] })
class InnerModule {}

/** Imports InnerModule but declares no resolvers of its own: the closure case. */
@Module({ imports: [InnerModule] })
class OuterModule {}

@Module({})
class PublicModule {}

/**
 * Registered to a module that is *not* in `include`. `TypeDefinitionsGenerator`
 * filters types by `registerIn` against the raw `include` array, so this is
 * what proves `includeModules` is forwarded to the schema factory: without
 * that forwarding, no filtering happens and `type Gadget` is emitted when the
 * boot path omits it.
 */
@ObjectType({ registerIn: PublicModule })
class Gadget {
  @Field()
  serial!: string;
}

/**
 * Target type for the `buildSchemaOptions.scalarsMap` collision case below.
 * A standalone marker class rather than a real-world type like `Date`, so the
 * case can't accidentally pass by coincidentally matching some unrelated
 * built-in scalar mapping.
 */
class CustomDateValue {}

/**
 * A discovered `@Scalar()` provider whose target type (`CustomDateValue`, via
 * the second decorator argument) collides with the user-supplied
 * `buildSchemaOptions.scalarsMap` entry declared alongside `userScalarsMap`
 * below. This is `dedupeAgainstUserScalars`'s reason to exist (see
 * `src/emitter/build.ts`): if the discovered scalar were appended rather than
 * dropped, `GraphQLSchemaFactory.create` would put two `GraphQLScalarType`s
 * both named "CustomDate" into the schema's `types` array, and
 * `new GraphQLSchema(...)` throws synchronously — "Schema must contain
 * uniquely named types but contains multiple types named \"CustomDate\"".
 */
@Scalar('CustomDate', () => CustomDateValue)
class CustomDateScalar {
  serialize(value: unknown): unknown {
    return value;
  }
}

const userScalarsMap = [
  { type: CustomDateValue, scalar: new GraphQLScalarType({ name: 'CustomDate', serialize: (v) => v }) },
];

/** Target type for the *non*-colliding discovered-scalar case below. */
class UppercaseValue {}

/**
 * A discovered `@Scalar()` provider that collides with nothing, so
 * `dedupeAgainstUserScalars` keeps it and it flows all the way into
 * `assignScalarObjects`. Without a case like this, the second argument to
 * `GraphQLSchemaFactory.create` is empty in every test in the suite — you
 * could replace it with `[]` and stay green — which leaves scalar forwarding
 * unverified on the byte-parity-critical path. (The other `@Scalar()` fixture
 * above is the collision case, where the correct behaviour is to *drop* it.)
 *
 * `description` is load-bearing, not decoration: `createScalarType` reads it
 * off the scalar *instance*, so it is the observable difference between the
 * boot path's DI-constructed instance and the `new classRef()` upstream
 * performs for us. A regression that stopped constructing the instance
 * correctly would show up here as a missing docstring rather than silently.
 */
@Scalar('Uppercase', () => UppercaseValue)
class UppercaseScalar {
  description = 'upper-cased strings';
  serialize(value: unknown): unknown {
    return value;
  }
}

/** Provider the DI-dependent scalar below injects. */
@Injectable()
class ScalarDescriptionService {
  describe(): string {
    return 'description that only DI can supply';
  }
}

/** Target type for the DI-dependent scalar. */
class InjectedValue {}

/**
 * A `@Scalar()` provider whose constructor touches an injected dependency.
 *
 * The boot path is fine with this — `ScalarsExplorerService` hands
 * `createScalarType` a fully DI-constructed *instance*. Schema regeneration
 * never instantiates providers, so `GraphQLSchemaFactory.create`'s
 * `new classRef()` throws, upstream swallows the throw into
 * `this.logger.error(...)`, and `logger: false` discards even that. See
 * `assertScalarsConstructibleWithoutInjection` in `src/emitter/build.ts`.
 */
@Scalar('Injected', () => InjectedValue)
class InjectedScalar {
  readonly description: string;
  constructor(private readonly descriptions: ScalarDescriptionService) {
    this.description = this.descriptions.describe();
  }
  serialize(value: unknown): unknown {
    return value;
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];
function schemaFile(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gqlparity-'));
  scratchDirs.push(dir);
  return path.join(dir, `${name}.gql`);
}

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function appModuleFor(
  gqlOptions: Partial<GqlModuleOptions>,
  extraImports: any[] = [],
  providers: any[] = [RecipesResolver],
): any {
  const AppModule = class {};
  Module({
    imports: [
      GraphQLModule.forRoot<ApolloDriverConfig>({
        driver: ApolloDriver,
        ...gqlOptions,
      } as ApolloDriverConfig),
      ...extraImports,
    ],
    providers,
  })(AppModule);
  return AppModule;
}

/** Ground truth: what `autoSchemaFile` actually writes during a real boot. */
async function bootAndReadSdl(AppModule: any, outFile: string): Promise<string> {
  const { NestFactory } = require('@nestjs/core');
  const app = await NestFactory.create(AppModule, { logger: false });
  try {
    await app.init();
    return readFileSync(outFile, 'utf8');
  } finally {
    await app.close();
  }
}

const replacementSchema = () =>
  new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: { transformedMarker: { type: GraphQLString } },
    }),
  });

interface ParityCase {
  name: string;
  /**
   * Which `SchemaConfig` fields this case establishes parity for.
   *
   * Documentation only. The `covers every SchemaConfig field` latch at the
   * bottom deliberately does **not** read this — nothing cross-checks prose
   * against behaviour, so a latch reading it would be satisfiable by typing a
   * field name into a string array. It reads `config` instead.
   */
  fields: Array<keyof SchemaConfig>;
  /** Extra options handed to `GraphQLModule.forRoot` at boot. */
  moduleOptions: Partial<GqlModuleOptions>;
  /** The matching `graphql.config` entry the emitter would read. */
  config: Omit<SchemaConfig, 'autoSchemaFile'>;
  extraImports?: any[];
  /** Defaults to `[RecipesResolver]` (see `appModuleFor`) when omitted. */
  providers?: any[];
  /** Asserted to be present/absent in the ground-truth SDL, so the case is proven meaningful. */
  bootMustContain?: string[];
  bootMustNotContain?: string[];
}

const cases: ParityCase[] = [
  {
    name: 'sortSchema: true',
    fields: ['sortSchema'],
    moduleOptions: { sortSchema: true },
    config: { sortSchema: true },
  },
  {
    name: 'sortSchema omitted (declaration order preserved)',
    fields: ['sortSchema'],
    moduleOptions: {},
    config: {},
  },
  {
    name: 'buildSchemaOptions.orphanedTypes',
    fields: ['buildSchemaOptions'],
    moduleOptions: { buildSchemaOptions: { orphanedTypes: [Ingredient] } },
    config: { buildSchemaOptions: { orphanedTypes: [Ingredient] } },
    bootMustContain: ['type Ingredient'],
  },
  {
    name: 'buildSchemaOptions.scalarsMap colliding with a discovered @Scalar()',
    fields: ['buildSchemaOptions'],
    moduleOptions: { buildSchemaOptions: { scalarsMap: userScalarsMap } },
    config: { buildSchemaOptions: { scalarsMap: userScalarsMap } },
    providers: [RecipesResolver, CustomDateScalar],
    // Proves the case is meaningful (the scalar really is emitted) and, more
    // importantly, that the boot path — which already de-duplicates in
    // `GraphQLSchemaBuilder.build` — does not choke on the collision, which
    // is the pre-condition for asserting byte parity against it below.
    bootMustContain: ['scalar CustomDate'],
  },
  {
    name: 'a discovered @Scalar() colliding with nothing reaches the SDL',
    // Sets no `SchemaConfig` field: what it pins is that the scalars harvested
    // from the preview container are forwarded as the second argument to
    // `GraphQLSchemaFactory.create`, which no other case in the suite does.
    fields: [],
    moduleOptions: {},
    config: {},
    providers: [RecipesResolver, UppercaseScalar],
    // `scalar Uppercase` proves the forwarding; the description proves the
    // scalar *instance* was constructed and read, which is the observable
    // that separates a DI-constructed instance from `new classRef()`.
    bootMustContain: ['scalar Uppercase', 'upper-cased strings'],
  },
  {
    name: 'buildSchemaOptions.addNewlineAtEnd (the level upstream declares it at)',
    // Only `buildSchemaOptions`. This case used to claim `addNewlineAtEnd`
    // too, but its `config` never sets a top-level `addNewlineAtEnd` — the
    // key it sets is `BuildSchemaOptions['addNewlineAtEnd']`, one nesting
    // level down, which is a different key on a different interface.
    // Conflating the two is the exact confusion that produced this package's
    // wrong-nesting-level defect, so the claim is dropped rather than
    // preserved; `SchemaConfig['addNewlineAtEnd']`, the legacy top-level
    // alias, is covered by the case immediately below.
    fields: ['buildSchemaOptions'],
    moduleOptions: { buildSchemaOptions: { addNewlineAtEnd: true } },
    config: { buildSchemaOptions: { addNewlineAtEnd: true } },
  },
  {
    name: 'addNewlineAtEnd as a legacy top-level alias',
    fields: ['addNewlineAtEnd'],
    // There is no top-level `addNewlineAtEnd` upstream, so the boot side must
    // use the nested form; the point of the case is that our legacy alias maps
    // onto it and produces the identical trailing byte.
    moduleOptions: { buildSchemaOptions: { addNewlineAtEnd: true } },
    config: { addNewlineAtEnd: true },
  },
  {
    name: 'transformSchema with transformAutoSchemaFile: true (applied)',
    fields: ['transformSchema', 'transformAutoSchemaFile'],
    moduleOptions: { transformSchema: replacementSchema, transformAutoSchemaFile: true },
    config: { transformSchema: replacementSchema, transformAutoSchemaFile: true },
    bootMustContain: ['transformedMarker'],
  },
  {
    name: 'transformSchema without transformAutoSchemaFile (NOT applied)',
    fields: ['transformSchema', 'transformAutoSchemaFile'],
    // The default. An app that transforms its *served* schema still writes an
    // untransformed SDL file, and we must match that, not "helpfully" apply it.
    moduleOptions: { transformSchema: replacementSchema },
    config: { transformSchema: replacementSchema },
    bootMustContain: ['type Recipe'],
    bootMustNotContain: ['transformedMarker'],
  },
  {
    name: 'include: [OuterModule] reaching resolvers through an imported module',
    fields: ['include'],
    moduleOptions: {
      include: [OuterModule],
      buildSchemaOptions: { orphanedTypes: [Gadget] },
      sortSchema: true,
    },
    config: {
      include: [OuterModule],
      buildSchemaOptions: { orphanedTypes: [Gadget] },
      sortSchema: true,
    },
    extraImports: [OuterModule, PublicModule],
    // Proves the closure walk: `widgets`/`Widget` live in InnerModule, which
    // is only reachable through OuterModule's `imports`.
    bootMustContain: ['widgets', 'type Widget'],
    // Proves `includeModules` forwarding: Gadget is registered to PublicModule,
    // which `include` excludes, so the boot path drops it despite the explicit
    // `orphanedTypes` entry. And `recipes` lives in the root module, also excluded.
    bootMustNotContain: ['type Gadget', 'recipes'],
  },
];

describe('SchemaConfig byte parity with the boot path', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, testCase) => {
    const outFile = schemaFile('schema');
    const AppModule = appModuleFor(
      { autoSchemaFile: outFile, ...testCase.moduleOptions },
      testCase.extraImports,
      testCase.providers,
    );

    const bootSdl = await bootAndReadSdl(AppModule, outFile);

    // Guard the case itself: a case whose ground truth doesn't actually
    // exercise the option would pass vacuously.
    for (const needle of testCase.bootMustContain ?? []) {
      expect(bootSdl).toContain(needle);
    }
    for (const needle of testCase.bootMustNotContain ?? []) {
      expect(bootSdl).not.toContain(needle);
    }

    const config: SchemaConfig = { autoSchemaFile: outFile, ...testCase.config };
    const ourSdl = await buildSdl(AppModule, buildSdlOptionsFrom(config));

    // Implied by the byte-parity assertion below, but checked first so that a
    // regression in the specific thing the case is *about* reports as a
    // one-line missing/present needle rather than as a whole-file diff.
    for (const needle of testCase.bootMustContain ?? []) {
      expect(ourSdl).toContain(needle);
    }
    for (const needle of testCase.bootMustNotContain ?? []) {
      expect(ourSdl).not.toContain(needle);
    }

    expect(ourSdl).toBe(bootSdl);
  });

  describe('autoSchemaFile', () => {
    // The SDL bytes don't depend on `autoSchemaFile`; *where they land* does.
    // Parity here means resolving the same destination the boot path writes to,
    // for each shape upstream accepts.
    it('resolves a plain string to the path the boot path writes', async () => {
      const outFile = schemaFile('string-form');
      const AppModule = appModuleFor({ autoSchemaFile: outFile, sortSchema: true });

      await bootAndReadSdl(AppModule, outFile);

      expect(existsSync(outFile)).toBe(true);
      expect(resolveOutFile(outFile, 'default')).toBe(outFile);
    });

    it('resolves a SchemaFileConfig object to the path the boot path writes', async () => {
      const outFile = schemaFile('object-form');
      const AppModule = appModuleFor({
        autoSchemaFile: { path: outFile },
        sortSchema: true,
      });

      await bootAndReadSdl(AppModule, outFile);

      // The shape that used to become the Tree path "/[object Object]".
      expect(existsSync(outFile)).toBe(true);
      expect(resolveOutFile({ path: outFile }, 'default')).toBe(outFile);
    });

    it('refuses `true`, which builds a schema but writes no file at boot', async () => {
      const AppModule = appModuleFor({ autoSchemaFile: true, sortSchema: true });
      const { NestFactory } = require('@nestjs/core');
      const app = await NestFactory.create(AppModule, { logger: false });
      await app.init();
      await app.close();

      // Nothing was written anywhere, so there is nothing for this schematic to
      // regenerate — which has to be an error, not the Tree path "/true".
      expect(() => resolveOutFile(true, 'default')).toThrow(/autoSchemaFile/);
    });
  });

  describe('a @Scalar() provider whose constructor needs its injected dependencies', () => {
    it('is emitted by a real boot, so we refuse loudly instead of diverging silently', async () => {
      const outFile = schemaFile('injected-scalar');
      const AppModule = appModuleFor(
        { autoSchemaFile: outFile, sortSchema: true },
        [],
        [RecipesResolver, ScalarDescriptionService, InjectedScalar],
      );

      // Ground truth: DI builds the instance, so the boot path emits the
      // scalar with the description only the injected service can produce.
      const bootSdl = await bootAndReadSdl(AppModule, outFile);
      expect(bootSdl).toContain('scalar Injected');
      expect(bootSdl).toContain('description that only DI can supply');

      // We never instantiate providers, so upstream's `new classRef()` throws
      // into a `catch` whose only effect is `this.logger.error(...)` — which
      // our `logger: false` discards. Left alone, that produces an SDL missing
      // `scalar Injected` entirely, with no diagnostic, while the emitter
      // reports success: the worst outcome for a package whose guarantee is
      // byte parity. The pre-flight in `buildSdl` turns it into an error that
      // names the culprit.
      const options = buildSdlOptionsFrom({ autoSchemaFile: outFile, sortSchema: true });
      await expect(buildSdl(AppModule, options)).rejects.toThrow(
        /The @Scalar\(\) provider "InjectedScalar" cannot be constructed without its injected dependencies/,
      );
      // The remedies, and the underlying cause, must survive into the message
      // — an error naming only the symptom sends the user back to a swallowed
      // log line that does not exist.
      await expect(buildSdl(AppModule, options)).rejects.toThrow(
        /buildSchemaOptions\.scalarsMap[\s\S]*Original error:/,
      );
    });
  });

  describe('teardown of the Nest contexts buildSdl opens', () => {
    /**
     * Both contexts are closed from a `finally`, so a `close()` that rejects
     * while a real error is already unwinding would *replace* it — the user
     * would be handed a teardown symptom and no trace of the cause.
     *
     * Forces every `NestFactory.createApplicationContext` result to reject on
     * `close()` (after really closing, so nothing leaks), which is the only
     * way to reach the branch: a healthy context does not fail to close.
     */
    function breakEveryContextClose(): () => void {
      const core = require('@nestjs/core');
      const original = core.NestFactory.createApplicationContext.bind(core.NestFactory);
      const spy = vi
        .spyOn(core.NestFactory, 'createApplicationContext')
        .mockImplementation(async (...args: unknown[]) => {
          const ctx = await original(...args);
          const realClose = ctx.close.bind(ctx);
          ctx.close = async () => {
            await realClose();
            throw new Error('teardown exploded');
          };
          return ctx;
        });
      return () => spy.mockRestore();
    }

    it('rethrows the primary error and only warns about the close failure', async () => {
      const outFile = schemaFile('teardown-primary');
      const AppModule = appModuleFor(
        { autoSchemaFile: outFile, sortSchema: true },
        [],
        [RecipesResolver, ScalarDescriptionService, InjectedScalar],
      );
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const restore = breakEveryContextClose();
      try {
        // The scalar pre-flight throws, then the preview context's close
        // throws on the way out. The scalar error is the one worth having.
        const rejection = buildSdl(AppModule, buildSdlOptionsFrom({ autoSchemaFile: outFile }));
        await expect(rejection).rejects.toThrow(/"InjectedScalar" cannot be constructed/);
        await expect(rejection).rejects.not.toThrow(/teardown exploded/);

        // Suppressed, not discarded: the close failure still reaches stderr.
        const warnings = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
        expect(warnings).toContain('failed to close the preview context');
        expect(warnings).toContain('teardown exploded');
      } finally {
        restore();
        stderr.mockRestore();
      }
    });

    it('still surfaces a close failure when nothing else went wrong', async () => {
      const outFile = schemaFile('teardown-only');
      const AppModule = appModuleFor({ autoSchemaFile: outFile, sortSchema: true });
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const restore = breakEveryContextClose();
      try {
        // With no primary error to protect, the close failure *is* the error —
        // preferring the primary must not become swallowing the only one.
        await expect(
          buildSdl(AppModule, buildSdlOptionsFrom({ autoSchemaFile: outFile })),
        ).rejects.toThrow('teardown exploded');
      } finally {
        restore();
        stderr.mockRestore();
      }
    });
  });

  it('covers every SchemaConfig field', () => {
    // Derived from the `config` objects the table actually feeds through
    // `buildSdlOptionsFrom` and `buildSdl` — deliberately *not* from each
    // case's hand-written `fields` array.
    //
    // `fields` is prose, and nothing cross-checks it against what the case's
    // `config` sets, so a latch reading it is satisfied by typing a field
    // name into a string array: `fields: ['include']` on a case that never
    // sets `include` would silence this test permanently. All three of this
    // package's real config defects (`autoSchemaFile`'s type, the missing
    // `transformAutoSchemaFile`, `addNewlineAtEnd`'s nesting level) would
    // have counted as "covered" after a one-word edit. Reading `config`
    // means a field is only covered once some case has actually driven a
    // value for it through to a byte-parity comparison.
    const covered = new Set<string>(cases.flatMap((c) => Object.keys(c.config)));
    // `autoSchemaFile` is covered by the nested describe above rather than by
    // the byte-parity table, because it decides the destination, not the bytes.
    covered.add('autoSchemaFile');

    expect([...covered].sort()).toEqual([...SCHEMA_CONFIG_FIELDS].sort());
  });
});
