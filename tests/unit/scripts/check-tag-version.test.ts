import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SCRIPT = join(__dirname, '../../../scripts/check-tag-version.sh');

function run(refType: string, refName: string, version = '2.1.1') {
  const dir = mkdtempSync(join(tmpdir(), 'tagcheck-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version }));
    const r = spawnSync('bash', [SCRIPT, dir], {
      env: { PATH: process.env['PATH'] ?? '', GITHUB_REF_TYPE: refType, GITHUB_REF_NAME: refName },
      encoding: 'utf8',
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('scripts/check-tag-version.sh', () => {
  it('passes when the tag is v plus the package.json version', () => {
    const r = run('tag', 'v2.1.1');
    expect(r.status).toBe(0);
    expect(r.out).toContain('matches package.json 2.1.1');
  });

  it('fails when the tag and the version differ', () => {
    const r = run('tag', 'v2.1.2');
    expect(r.status).toBe(1);
    expect(r.out).toContain('does not match package.json version 2.1.1');
  });

  it('fails on a branch ref, even when the name looks right', () => {
    const r = run('branch', 'v2.1.1');
    expect(r.status).toBe(1);
    expect(r.out).toContain('must run on a version tag');
  });

  it('passes a prerelease tag that equals the prerelease version', () => {
    expect(run('tag', 'v2.2.0-beta.1', '2.2.0-beta.1').status).toBe(0);
  });
});
