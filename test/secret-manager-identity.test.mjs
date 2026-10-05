import test from 'node:test';
import assert from 'node:assert/strict';
import { liveSecretId } from '../lib/get-resources.mjs';
import { normalizeTofuState, classifyResources } from '../lib/controller-inventory.mjs';

test('live secret ID is the short name whether displayName is short or a full resource path', () => {
  assert.equal(liveSecretId({ displayName: 'api-token' }), 'api-token');
  assert.equal(liveSecretId({ displayName: 'projects/446859768387/secrets/api-token' }), 'api-token');
  assert.equal(liveSecretId({}), undefined);
  assert.equal(liveSecretId(undefined), undefined);
});

test('imported secret is covered when Cloud Asset reports a project-number path', () => {
  const { resources } = normalizeTofuState({
    values: {
      root_module: {
        resources: [{
          address: 'google_secret_manager_secret.api_token',
          mode: 'managed',
          type: 'google_secret_manager_secret',
          values: { project: 'demo', secret_id: 'api-token' },
        }],
      },
    },
  }, 'infra', { defaultProject: 'demo' });
  const live = [{
    project: 'demo',
    kind: 'SecretManagerSecret',
    id: liveSecretId({ displayName: 'projects/123/secrets/api-token' }),
    source: 'gcp',
  }];
  const results = classifyResources(live, resources);
  assert.deepEqual(results.map((r) => [r.kind, r.id, r.status]), [['SecretManagerSecret', 'api-token', 'covered_opentofu']]);
});
