import test from 'node:test';
import assert from 'node:assert/strict';
import {
  liveIamPolicyIds,
  liveIamPolicyResources,
  replaceBucketIamPolicies,
} from '../lib/get-resources.mjs';

const searchEntries = [
  {
    assetType: 'cloudresourcemanager.googleapis.com/Project',
    resource: '//cloudresourcemanager.googleapis.com/projects/nitraai',
    policy: {
      bindings: [{
        role: 'roles/viewer',
        members: ['user:reader@example.com'],
      }],
    },
  },
  {
    assetType: 'storage.googleapis.com/Bucket',
    resource: '//storage.googleapis.com/indexed-bucket',
    policy: {
      bindings: [{
        role: 'roles/storage.objectViewer',
        members: ['user:indexed@example.com'],
      }],
    },
  },
];

const bucketAssets = [
  {
    assetType: 'storage.googleapis.com/Bucket',
    name: '//storage.googleapis.com/indexed-bucket',
    iamPolicy: {
      bindings: [{
        role: 'roles/storage.objectViewer',
        members: ['user:indexed@example.com'],
      }],
    },
  },
  {
    assetType: 'storage.googleapis.com/Bucket',
    name: '//storage.googleapis.com/missing-from-search',
    iamPolicy: {
      bindings: [
        {
          role: 'roles/storage.legacyBucketOwner',
          members: ['projectOwner:nitraai'],
        },
        {
          role: 'roles/storage.objectAdmin',
          members: ['serviceAccount:writer@nitraai.iam.gserviceaccount.com'],
        },
        {
          role: 'roles/storage.objectViewer',
          members: ['allUsers'],
        },
      ],
    },
  },
];

test('replaces the incomplete bucket search slice with IAM_POLICY assets', () => {
  const entries = replaceBucketIamPolicies(searchEntries, bucketAssets);
  const bucketEntries = entries.filter((entry) => entry.assetType === 'storage.googleapis.com/Bucket');

  assert.deepEqual(bucketEntries.map((entry) => entry.resource), [
    '//storage.googleapis.com/indexed-bucket',
    '//storage.googleapis.com/missing-from-search',
  ]);
  assert.equal(entries.filter((entry) => entry.assetType === 'cloudresourcemanager.googleapis.com/Project').length, 1);
});

test('covers bucket service-account and public bindings while filtering legacy ACL noise', () => {
  const entries = replaceBucketIamPolicies(searchEntries, bucketAssets);
  const ids = liveIamPolicyIds(entries, 'nitraai');

  assert.ok(ids.includes(
    'bucket/missing-from-search/roles/storage.objectAdmin/serviceAccount:writer@nitraai.iam.gserviceaccount.com',
  ));
  assert.ok(ids.includes(
    'bucket/missing-from-search/roles/storage.objectViewer/allUsers',
  ));
  assert.ok(!ids.some((id) => id.includes('projectOwner:nitraai')));
});

test('keeps legacy bucket bindings when system resources are explicitly included', () => {
  const entries = replaceBucketIamPolicies(searchEntries, bucketAssets);
  const ids = liveIamPolicyIds(entries, 'nitraai', true);

  assert.ok(ids.includes(
    'bucket/missing-from-search/roles/storage.legacyBucketOwner/projectOwner:nitraai',
  ));
});

test('preserves IAM conditions alongside the canonical binding ID', () => {
  const resources = liveIamPolicyResources([{
    assetType: 'cloudresourcemanager.googleapis.com/Project',
    resource: '//cloudresourcemanager.googleapis.com/projects/nitraai',
    policy: {
      bindings: [{
        role: 'roles/iam.workloadIdentityPoolAdmin',
        members: ['serviceAccount:kcc-nitraai@nitraai.iam.gserviceaccount.com'],
        condition: {
          title: 'provider-only',
          expression: 'resource.name == provider',
        },
      }],
    },
  }], 'nitraai');

  assert.equal(resources[0].condition.title, 'provider-only');
  assert.match(resources[0].id, /roles\/iam\.workloadIdentityPoolAdmin/);
});
