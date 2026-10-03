import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAndClassify, hasBlockingFindings } from '../lib/tofu-inventory.mjs';

test('classifies a project from live GCP facts and OpenTofu state without KCC declarations', async () => {
  const result = await collectAndClassify('nitraai', ['infra/tofu'], {
    collectProjectFn: async (project, options) => {
      assert.equal(project, 'nitraai');
      assert.equal(options.includeSystem, false);
      return {
        resources: [
          { kind: 'StorageBucket', id: 'state', source: 'gcp' },
          { kind: 'StorageBucket', id: 'manual', source: 'gcp' },
        ],
        diagnostics: [],
      };
    },
    collectOpenTofuFn: (paths, options) => {
      assert.deepEqual(paths, ['infra/tofu']);
      assert.deepEqual(options, { defaultProject: 'nitraai' });
      return {
        resources: [
          {
            project: 'nitraai',
            kind: 'StorageBucket',
            id: 'state',
            controller: 'opentofu',
            source: 'infra/tofu',
          },
          {
            project: 'another-project',
            kind: 'StorageBucket',
            id: 'outside-scope',
            controller: 'opentofu',
            source: 'infra/tofu',
          },
        ],
        diagnostics: [],
      };
    },
  });

  assert.deepEqual(result.results.map(({ id, status }) => ({ id, status })), [
    { id: 'state', status: 'covered_opentofu' },
    { id: 'manual', status: 'uncovered' },
  ]);
  assert.equal(hasBlockingFindings(result.results, result.tofuDiagnostics), true);
});

test('strict findings include unsupported OpenTofu resource types', () => {
  assert.equal(hasBlockingFindings([], [{ resourceType: 'google_unknown' }]), true);
  assert.equal(hasBlockingFindings([{ status: 'covered_opentofu' }], []), false);
});
