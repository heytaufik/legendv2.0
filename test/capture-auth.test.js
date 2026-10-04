import test from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorizedCaptureRequest } from '../lib/capture-auth.js';

test('allows loopback capture without a token for local development', () => {
  assert.equal(isAuthorizedCaptureRequest({
    remoteAddress: '127.0.0.1',
    authorization: undefined,
    configuredToken: ''
  }), true);
  assert.equal(isAuthorizedCaptureRequest({
    remoteAddress: '::ffff:127.0.0.1',
    authorization: undefined,
    configuredToken: ''
  }), true);
});

test('requires a matching bearer token for remote capture', () => {
  const request = { remoteAddress: '203.0.113.5', configuredToken: 'test-capture-token' };

  assert.equal(isAuthorizedCaptureRequest({ ...request, authorization: undefined }), false);
  assert.equal(isAuthorizedCaptureRequest({ ...request, authorization: 'Bearer wrong-token' }), false);
  assert.equal(isAuthorizedCaptureRequest({ ...request, authorization: 'test-capture-token' }), false);
  assert.equal(isAuthorizedCaptureRequest({ ...request, authorization: 'Bearer test-capture-token' }), true);
});

test('requires the bearer token even for loopback when remote capture is enabled', () => {
  const request = { remoteAddress: '127.0.0.1', configuredToken: 'test-capture-token' };

  assert.equal(isAuthorizedCaptureRequest({ ...request, authorization: undefined }), false);
  assert.equal(isAuthorizedCaptureRequest({ ...request, authorization: 'Bearer test-capture-token' }), true);
});
