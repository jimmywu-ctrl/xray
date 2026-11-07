import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramMonitor } from '../src/adapters/telegram/monitor.ts';

function monitor() {
  const m = new TelegramMonitor(() => {});
  m.credentials = { apiId: 1, apiHash: '0'.repeat(32) };
  m.account = 'test';
  m.state = 'connected';
  m.transportState = 'connected';
  m.client = { destroy: async () => {} };
  return m;
}

test('a dropped connection changes status and native recovery cancels fallback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = monitor(), client = m.client;
  m.connectionChanged(client, 'offline');
  assert.equal(m.status().state, 'reconnecting');
  assert.ok(m.recoveryTimer);
  m.connectionChanged(client, 'connected');
  assert.equal(m.status().state, 'connected');
  assert.equal(m.recoveryTimer, null);
  await m.stop();
});

test('stuck transport replaces client, restores update listening, ignores old events', async () => {
  const m = monitor(), old = m.client;
  let destroyed = 0, updates = 0;
  old.destroy = async () => destroyed++;
  m.getClient = async () => {
    m.client = {
      getMe: async () => ({ username: 'test', displayName: 'test' }),
      startUpdatesLoop: async () => updates++,
      destroy: async () => {},
    };
    m.connectionChanged(m.client, 'connected');
    return m.client;
  };
  await m.recoverConnection();
  assert.equal(destroyed, 1);
  assert.equal(updates, 1);
  assert.equal(m.status().state, 'connected');
  m.connectionChanged(old, 'offline');
  assert.equal(m.status().state, 'connected');
  await m.stop();
});

test('failed recovery backs off, does not run concurrently, and stop cancels retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = monitor();
  let calls = 0, finish;
  m.reconnect = async () => {
    calls++;
    await new Promise(resolve => { finish = resolve; });
    m.state = 'error';
  };
  const pending = m.recoverConnection();
  await Promise.resolve();
  await Promise.resolve();
  await m.recoverConnection();
  assert.equal(calls, 1);
  finish();
  await pending;
  assert.equal(m.retryDelay, 60_000);
  assert.ok(m.recoveryTimer);
  await m.stop();
  t.mock.timers.tick(120_000);
  assert.equal(calls, 1);
});

test('revoked login ends recovery rather than retrying forever', async () => {
  const m = monitor();
  m.getClient = async () => (m.client = {
    getMe: async () => { throw new Error('SESSION_REVOKED'); },
    destroy: async () => {},
  });
  await m.recoverConnection();
  assert.equal(m.status().state, 'signed_out');
  assert.equal(m.recoveryTimer, null);
  await m.stop();
});

test('connection timeout schedules recovery and a late transport event cannot cancel login repair', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = monitor();
  m.client.getMe = () => new Promise(() => {});
  const pending = m.reconnect(123);
  await Promise.resolve();
  t.mock.timers.tick(20_000);
  await pending;
  assert.equal(m.status().state, 'error');
  assert.ok(m.recoveryTimer);
  m.connectionChanged(m.client, 'connected');
  assert.ok(m.recoveryTimer);
  await m.stop();
});
