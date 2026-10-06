import {
  afterEach,
  beforeEach,
  describe,
  it,
  expect,
  vi,
  type Mock,
} from 'vitest';
import {
  PushNotificationClient,
  type PushMessage,
} from './push-notification.client';

const MESSAGE: PushMessage = {
  userId: '22222222-2222-4222-8222-222222222222',
  eventId: 'reminder:b1:confirm_24h:1791180000000',
  title: 'Your appointment is tomorrow',
  body: 'Full colour at 10:00 AM. Booking GS-1050.',
  data: { type: 'reminder.confirm_24h', bookingId: 'b1' },
};

const reply = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

const savedKey = process.env.PUSH_API_KEY;
let fetchMock: Mock<typeof fetch>;

beforeEach(() => {
  process.env.PUSH_API_KEY = 'test-key';
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedKey === undefined) delete process.env.PUSH_API_KEY;
  else process.env.PUSH_API_KEY = savedKey;
});

describe('what push-app said, classified', () => {
  it('202 for two devices is sent, and says how many', async () => {
    fetchMock.mockResolvedValue(
      reply(202, { devices: 2, queued: 2, duplicates: 0 }),
    );
    expect(await new PushNotificationClient().send(MESSAGE, 1)).toEqual({
      kind: 'sent',
      ref: 'devices=2',
    });
  });

  it('202 for a retry push-app already had is still sent: the dedupe did its job', async () => {
    fetchMock.mockResolvedValue(
      reply(202, { devices: 1, queued: 0, duplicates: 1 }),
    );
    expect((await new PushNotificationClient().send(MESSAGE, 1)).kind).toBe(
      'sent',
    );
  });

  it('202 with zero devices is NOT a delivery', async () => {
    fetchMock.mockResolvedValue(
      reply(202, { devices: 0, queued: 0, duplicates: 0 }),
    );
    expect(await new PushNotificationClient().send(MESSAGE, 1)).toEqual({
      kind: 'skipped',
      reason: 'no_devices',
    });
  });

  it('401 is a permanent failure: retrying will not fix a wrong key', async () => {
    fetchMock.mockResolvedValue(reply(401));
    expect(await new PushNotificationClient().send(MESSAGE, 1)).toEqual({
      kind: 'failed',
      error: 'HTTP 401',
    });
  });

  it('503 is worth retrying', async () => {
    fetchMock.mockResolvedValue(reply(503));
    expect(await new PushNotificationClient().send(MESSAGE, 1)).toEqual({
      kind: 'retry',
      error: 'push-app unreachable: HTTP 503',
    });
  });

  it('a connection refused is worth retrying', async () => {
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const got = await new PushNotificationClient().send(MESSAGE, 1);
    expect(got.kind).toBe('retry');
  });

  it('no PUSH_API_KEY: skipped, and nothing is sent', async () => {
    process.env.PUSH_API_KEY = '';
    expect(await new PushNotificationClient().send(MESSAGE, 1)).toEqual({
      kind: 'skipped',
      reason: 'push_not_configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('one attempt means one request: the dispatcher does its own retrying', async () => {
    fetchMock.mockResolvedValue(reply(503));
    await new PushNotificationClient().send(MESSAGE, 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the eventId it was given, which is what push-app dedupes on', async () => {
    fetchMock.mockResolvedValue(reply(202, { devices: 1 }));
    await new PushNotificationClient().send(MESSAGE, 1);
    const [, init] = fetchMock.mock.calls[0]!;
    const sent = JSON.parse(init!.body as string) as PushMessage;
    expect(sent.eventId).toBe(MESSAGE.eventId);
    expect(init!.headers).toMatchObject({
      'x-api-key': 'test-key',
    });
  });
});
