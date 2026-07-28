import { resolveProject } from '../src/config/project';

describe('resolveProject', () => {
  it('handles a standard single-app layout', () => {
    const r = resolveProject({ sourceRoot: 'src', entryFile: 'main' });
    expect(r).toEqual({ sourceRoot: 'src', distRoot: 'dist', entryFile: 'main' });
  });

  it('defaults entryFile to main when absent', () => {
    expect(resolveProject({ sourceRoot: 'src' }).entryFile).toBe('main');
  });

  it('resolves a named monorepo project with distinct root paths', () => {
    const config = {
      sourceRoot: 'apps/api/src',
      entryFile: 'main',
      monorepo: true,
      projects: {
        api: { sourceRoot: 'packages/backend/src', root: 'packages/backend' },
        admin: { sourceRoot: 'services/back-office/src', root: 'services/back-office' },
      },
    };

    // Test admin project (Finding 1: ensure root is not coincidentally matching projectName)
    const admin = resolveProject(config, 'admin');
    expect(admin.sourceRoot).toBe('services/back-office/src');
    expect(admin.distRoot).toBe('dist/services/back-office');

    // Test api project (Finding 1: verify both entries are distinct)
    const api = resolveProject(config, 'api');
    expect(api.sourceRoot).toBe('packages/backend/src');
    expect(api.distRoot).toBe('dist/packages/backend');
  });

  it('throws listing available projects for an unknown name', () => {
    expect(() =>
      resolveProject({ sourceRoot: 'src', projects: { api: { sourceRoot: 'apps/api/src' } } }, 'ghost'),
    ).toThrow(/ghost.*api/s);
  });

  it('project-level entryFile overrides top-level', () => {
    const r = resolveProject(
      {
        sourceRoot: 'src',
        entryFile: 'bootstrap',
        projects: {
          api: { sourceRoot: 'apps/api/src', root: 'apps/api', entryFile: 'server' },
        },
      },
      'api',
    );
    expect(r.entryFile).toBe('server');
  });

  it('top-level entryFile passes through when project has none', () => {
    const r = resolveProject(
      {
        sourceRoot: 'src',
        entryFile: 'bootstrap',
        projects: {
          api: { sourceRoot: 'apps/api/src', root: 'apps/api' },
        },
      },
      'api',
    );
    expect(r.entryFile).toBe('bootstrap');
  });

  it('throws when monorepo project lacks sourceRoot', () => {
    expect(() =>
      resolveProject(
        {
          sourceRoot: 'src',
          projects: {
            api: { root: 'apps/api' },
          },
        },
        'api',
      ),
    ).toThrow(/api.*sourceRoot/);
  });
});
