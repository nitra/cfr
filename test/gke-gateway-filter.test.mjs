import test from 'node:test';
import assert from 'node:assert/strict';
import { isGkeGatewayManaged } from '../lib/get-resources.mjs';

test('recognizes regional and global GKE Gateway controller resources', () => {
  assert.equal(isGkeGatewayManaged('us-central1/gkegw1-4v0d-adminer-adminer-hl-8080-a1b2c3'), true);
  assert.equal(isGkeGatewayManaged('global/gkegw12-4v0d-gw-main-a1b2c3'), true);
});

test('does not hide similarly scoped user-owned Load Balancer resources', () => {
  assert.equal(isGkeGatewayManaged('us-central1/adminer-backend'), false);
  assert.equal(isGkeGatewayManaged('global/public-url-map'), false);
});
