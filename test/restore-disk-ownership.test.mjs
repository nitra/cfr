import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreDiskOrigins, classifyRestoreDerived } from '../lib/restore-disk-ownership.mjs';
import { collectAndClassify, hasBlockingFindings } from '../lib/tofu-inventory.mjs';

const volume = {
  state: 'SUCCEEDED', volumeType: 'GCE_PERSISTENT_DISK',
  name: 'projects/123/locations/eu/restorePlans/recovery/restores/run/volumeRestores/one',
  volumeHandle: 'projects/demo/zones/eu-a/disks/restored',
  targetPvc: { namespace: 'default', name: 'data' },
};

test('only exact successful same-project disk handles establish RestorePlan origin', () => {
  assert.equal(restoreDiskOrigins('demo', 'eu/recovery', [volume]).get('eu-a/restored').targetPvc.name, 'data');
  for (const patch of [
    { state: 'FAILED' }, { state: 'RESTORING' }, { volumeType: 'UNSPECIFIED' },
    { volumeHandle: 'projects/other/zones/eu-a/disks/restored' },
    { volumeHandle: 'pvc-looking-name' },
    { name: volume.name.replace('/recovery/', '/another/') },
  ]) assert.equal(restoreDiskOrigins('demo', 'eu/recovery', [{ ...volume, ...patch }]).size, 0);
  assert.throws(() => restoreDiskOrigins('demo', 'eu/recovery', [{ ...volume, targetPvc: {} }]), /Missing target PVC/);
});

test('derived disks require a live RestorePlan covered by supplied actual state; manual disks remain uncovered', async () => {
  const derivedFrom = restoreDiskOrigins('demo', 'eu/recovery', [volume]).get('eu-a/restored');
  const live = [
    { kind: 'GKEBackupRestorePlan', id: 'eu/recovery', source: 'gcp' },
    { kind: 'ComputeDisk', id: 'eu-a/restored', source: 'gcp', derivedFrom },
    { kind: 'ComputeDisk', id: 'eu-a/pvc-manual', source: 'gcp' },
  ];
  const collectProjectFn = async () => ({ resources: live, diagnostics: [] });
  const collectOpenTofuFn = () => ({ resources: [{ project: 'demo', kind: 'GKEBackupRestorePlan',
    id: 'eu/recovery', controller: 'opentofu', source: 'test-state' }], diagnostics: [] });
  const withState = await collectAndClassify('demo', ['test-state'], { collectProjectFn, collectOpenTofuFn });
  const disk = withState.results.find((r) => r.id === 'eu-a/restored');
  assert.equal(disk.status, 'controller_managed');
  assert.equal(disk.parentState, 'test-state');
  assert.equal(withState.results.find((r) => r.id === 'eu-a/pvc-manual').status, 'uncovered');
  const withoutState = await collectAndClassify('demo', [], { collectProjectFn,
    collectOpenTofuFn: () => ({ resources: [], diagnostics: [] }) });
  assert.equal(withoutState.results.find((r) => r.id === 'eu-a/restored').status, 'uncovered');
  assert.equal(hasBlockingFindings([disk], []), false);
  assert.equal(hasBlockingFindings(withoutState.results, []), true);
  const coveredDisk = { ...disk, status: 'covered_opentofu', source: 'explicit-disk-state' };
  assert.deepEqual(classifyRestoreDerived([coveredDisk]), [coveredDisk]);
  assert.equal(classifyRestoreDerived([{ ...disk, status: 'uncovered' }])[0].status, 'uncovered');
});
