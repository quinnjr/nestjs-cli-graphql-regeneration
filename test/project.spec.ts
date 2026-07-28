import { resolveProject } from '../src/config/project';

describe('resolveProject', () => {
  it('handles a standard single-app layout', () => {
    const r = resolveProject({ sourceRoot: 'src', entryFile: 'main' });
    expect(r).toEqual({ sourceRoot: 'src', distRoot: 'dist', entryFile: 'main' });
  });

  it('defaults entryFile to main when absent', () => {
    expect(resolveProject({ sourceRoot: 'src' }).entryFile).toBe('main');
  });

  it('resolves a named monorepo project', () => {
    const r = resolveProject(
      {
        sourceRoot: 'apps/api/src',
        monorepo: true,
        projects: {
          api: { sourceRoot: 'apps/api/src', root: 'apps/api' },
          admin: { sourceRoot: 'apps/admin/src', root: 'apps/admin' },
        },
      },
      'admin',
    );
    expect(r.sourceRoot).toBe('apps/admin/src');
    expect(r.distRoot).toBe('dist/apps/admin');
  });

  it('throws listing available projects for an unknown name', () => {
    expect(() =>
      resolveProject({ sourceRoot: 'src', projects: { api: { sourceRoot: 'apps/api/src' } } }, 'ghost'),
    ).toThrow(/ghost.*api/s);
  });
});
