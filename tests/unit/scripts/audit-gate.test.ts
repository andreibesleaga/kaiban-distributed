import { evaluate, parseIgnores } from '../../../scripts/audit-gate';

const TODAY = '2026-10-24';
const ZOD = 'https://github.com/advisories/GHSA-mrhx-c7xc-m3w5';
const BODY = 'https://github.com/advisories/GHSA-27r3-jxmh-p828';
const OTEL = 'https://github.com/advisories/GHSA-qqmp-wf37-98f9';

const audit = {
  vulnerabilities: {
    zod: { via: [{ name: 'zod', range: '<4.6.6', title: 'Zod memory', url: ZOD, severity: 'high' }] },
    openai: { via: ['zod'] },
    kaibanjs: { via: [{ name: 'zod', range: '<4.6.6', title: 'Zod memory', url: ZOD, severity: 'high' }, 'openai'] },
    'body-parser': { via: [{ name: 'body-parser', range: '>=2.0.0 <2.4.0', title: 'DoS', url: BODY, severity: 'high' }] },
    '@opentelemetry/instrumentation-pg': {
      via: [{ name: '@opentelemetry/instrumentation-pg', range: '<0.73.0', title: 'user name', url: OTEL, severity: 'moderate' }],
    },
  },
};

describe('scripts/audit-gate', () => {
  it('blocks every HIGH advisory when nothing is waived, once per advisory, never a moderate', () => {
    const r = evaluate(audit, '', TODAY);
    expect(r.blocking).toHaveLength(2);
    expect(r.blocking.join('\n')).toContain('GHSA-mrhx-c7xc-m3w5');
    expect(r.blocking.join('\n')).toContain('GHSA-27r3-jxmh-p828');
    expect(r.blocking.join('\n')).not.toContain('GHSA-qqmp-wf37-98f9');
    expect(r.waived).toEqual([]);
  });

  it('waives only the advisories listed with an unexpired date', () => {
    const r = evaluate(audit, '# zod 3 via kaibanjs\nGHSA-mrhx-c7xc-m3w5 exp:2026-12-31\nCVE-2023-54404 exp:2026-12-31\n', TODAY);
    expect(r.blocking).toHaveLength(1);
    expect(r.blocking[0]).toContain('body-parser');
    expect(r.waived).toHaveLength(1);
    expect(r.waived[0]).toContain('zod');
  });

  it('enforces an expired exception again and reports it', () => {
    const r = evaluate(audit, 'GHSA-mrhx-c7xc-m3w5 exp:2026-10-23\n', TODAY);
    expect(r.blocking).toHaveLength(2);
    expect(r.expired).toEqual(['GHSA-mrhx-c7xc-m3w5']);
  });

  it('keeps an exception on its expiry day and one without a date', () => {
    expect([...parseIgnores('A exp:2026-10-24\nB\n\n# c\n', TODAY).active]).toEqual(['A', 'B']);
  });

  it('rejects output that is not an npm audit report', () => {
    expect(() => evaluate({ error: { code: 'ENOLOCK' } }, '', TODAY)).toThrow(/npm audit/);
  });
});
