import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { Recipe } from './recipe.model';

@Resolver(() => Recipe)
export class RecipesResolver {
  @Query(() => [Recipe])
  recipes(): Recipe[] {
    return [];
  }

  @Query(() => Recipe, { nullable: true })
  recipe(@Args('id', { type: () => ID }) id: string): Recipe | null {
    return null;
  }
}
