import test from 'node:test';
import assert from 'node:assert/strict';
import { printDiagnostic } from '../lib/kcc-inventory.mjs';

test('includes GKE-managed DNS zones in JSON ignored diagnostics', () => {
  const results = [];

  printDiagnostic({
    kind: 'DNSManagedZone',
    type: 'gke-managed-skip',
    zones: ['gke-main-dns'],
  }, true, results, 'nitraai');

  assert.deepEqual(results, [{
    kind: 'DNSManagedZone',
    id: 'gke_managed:1',
    project: 'nitraai',
    status: 'ignored',
  }]);
});
