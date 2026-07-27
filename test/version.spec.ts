import { PACKAGE_NAME } from '../src/version';

describe('toolchain', () => {
  it('compiles and exports a constant', () => {
    expect(PACKAGE_NAME).toBe('@scope/nest-graphql');
  });
});
