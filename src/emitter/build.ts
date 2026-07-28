import { GraphQLSchema } from 'graphql';
import { harvest, ContainerLike } from './harvest';
import { serialize, SerializeOptions } from './serialize';
import { createPreviewContext } from './preview';

export interface BuildSdlOptions extends SerializeOptions {
  buildSchemaOptions?: Record<string, unknown>;
  include?: Function[];
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
        scalars,
        opts.buildSchemaOptions ?? {},
      );
      sdl = await serialize(schema, opts);
    } finally {
      await schemaCtx.close();
    }
  } finally {
    await previewCtx.close();
  }

  return sdl;
}
