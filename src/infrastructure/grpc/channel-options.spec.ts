import { describe, it, expect, afterEach } from 'vitest';
import { platformChannelOptions } from './channel-options';

const KEYS = ['GRPC_KEEPALIVE_TIME_MS', 'GRPC_KEEPALIVE_TIMEOUT_MS'];
afterEach(() => KEYS.forEach((k) => delete process.env[k]));

describe('platformChannelOptions', () => {
  it('defaults to 30s, which this peer was measured to tolerate', () => {
    const o = platformChannelOptions();
    expect(o['grpc.keepalive_time_ms']).toBe(30_000);
    expect(o['grpc.keepalive_timeout_ms']).toBe(10_000);
  });

  it('pings while idle, which is the only time it helps', () => {
    // A busy connection proves itself with its own traffic. Without this,
    // keepalive does nothing for the case it was added for.
    expect(
      platformChannelOptions()['grpc.keepalive_permit_without_calls'],
    ).toBe(1);
  });

  it('can be raised for a peer that enforces the C-core floor', () => {
    // A proxy in front of platform may strike pings that platform itself
    // accepts. Raising this is the fix, so it must be reachable.
    process.env.GRPC_KEEPALIVE_TIME_MS = '300000';
    expect(platformChannelOptions()['grpc.keepalive_time_ms']).toBe(300_000);
  });

  it('refuses a malformed value instead of taking it as zero', () => {
    // `keepalive_time_ms: 0` is not "disabled", it is "ping constantly",
    // which earns a GOAWAY. A typo in an env var must not do that.
    for (const bad of ['', '   ', 'nope', '0', '-1', 'NaN']) {
      process.env.GRPC_KEEPALIVE_TIME_MS = bad;
      expect(platformChannelOptions()['grpc.keepalive_time_ms']).toBe(30_000);
    }
  });
});
