import * as path from 'path';
import { assertInsideProject, resolveProject } from '../src/config/project';

describe('resolveProject', () => {
  it('handles a standard single-app layout', () => {
    // `sourceRoot`/`entryFile` are still perfectly legal nest-cli.json fields; they are
    // simply not part of what this tool resolves, so they must pass through harmlessly
    // rather than appear on the result.
    expect(resolveProject({ sourceRoot: 'src', entryFile: 'main' })).toEqual({ distRoot: 'dist' });
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

    // Both entries are asserted so a `root` that only coincidentally matched the
    // requested project name could not pass.
    expect(resolveProject(config, 'admin').distRoot).toBe('dist/services/back-office');
    expect(resolveProject(config, 'api').distRoot).toBe('dist/packages/backend');
  });

  it('falls back to the plain dist root for a project declaring no root', () => {
    // Nothing about a project entry is required by this tool any more -- it reads
    // exactly one field, `root`, and that one is optional. A nest-cli.json that omits
    // everything else is still valid input and must not be rejected.
    expect(resolveProject({ projects: { api: {} } }, 'api')).toEqual({ distRoot: 'dist' });
  });

  it('throws listing available projects for an unknown name', () => {
    expect(() =>
      resolveProject({ sourceRoot: 'src', projects: { api: { sourceRoot: 'apps/api/src' } } }, 'ghost'),
    ).toThrow(/ghost.*api/s);
  });
});

// `root` is user-controlled config text that ends up as `dist/${root}`, and whatever
// that names is what gets `require()`d -- both the compiled graphql.config.js and the
// app module. `../../..` normalizes to any absolute path on the machine, so without a
// containment check a nest-cli.json can direct this tool to load and execute arbitrary
// code. The write side always refused to leave the project root; these prove the
// read/execute side now does too.
describe('resolveProject — containment of nest-cli.json "root"', () => {
  const projectRoot = path.join(path.sep, 'srv', 'workspace', 'app');

  it('rejects a relative root that climbs out of the project', () => {
    const attempt = () =>
      resolveProject({ projects: { api: { root: '../../etc' } } }, 'api', projectRoot);

    // The message has to identify both the project and the offending value, or the
    // user cannot tell which of several nest-cli.json entries to go and fix.
    expect(attempt).toThrow(/outside the project root/);
    expect(attempt).toThrow(/"api"/);
    expect(attempt).toThrow(/\.\.\/\.\.\/etc/);
  });

  it('rejects an absolute root pointing elsewhere on the filesystem', () => {
    const outside = path.join(path.sep, 'etc');
    const attempt = () =>
      resolveProject({ projects: { api: { root: outside } } }, 'api', projectRoot);

    expect(attempt).toThrow(/outside the project root/);
    expect(attempt).toThrow(/"api"/);
  });

  it('rejects a root that walks out and back in through an absolute prefix', () => {
    // Normalization, not string matching: this contains no leading ".." at all.
    expect(() =>
      resolveProject(
        { projects: { api: { root: 'apps/../../elsewhere' } } },
        'api',
        projectRoot,
      ),
    ).toThrow(/outside the project root/);
  });

  it('accepts a root that genuinely is inside the project', () => {
    // The check is containment, not a blanket ban on unusual-looking values: a path
    // that normalizes back to somewhere under the project root is fine.
    expect(() =>
      resolveProject({ projects: { api: { root: 'apps/../apps/api' } } }, 'api', projectRoot),
    ).not.toThrow();
  });
});

describe('assertInsideProject', () => {
  const projectRoot = path.join(path.sep, 'srv', 'workspace', 'app');

  it('returns the resolved absolute path for a contained candidate', () => {
    expect(assertInsideProject(projectRoot, 'dist/apps/api', 'The thing')).toBe(
      path.join(projectRoot, 'dist', 'apps', 'api'),
    );
  });

  it('treats the project root itself as inside, leaving that case to callers', () => {
    // `toTreePath` needs to reject "resolves to the root itself" with its own distinct
    // message, so this helper must not pre-empt it by throwing "outside" first.
    expect(assertInsideProject(projectRoot, '.', 'The thing')).toBe(projectRoot);
  });

  it('appends the caller-supplied hint to the failure message', () => {
    expect(() =>
      assertInsideProject(projectRoot, '../escape', 'The thing', 'Go and fix it.'),
    ).toThrow(/outside the project root ".*". Go and fix it\./);
  });
});
