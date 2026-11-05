const send = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(),
  PutObjectCommand: jest.fn((input) => ({ input })),
  GetObjectCommand: jest.fn((input) => ({ input })),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(async (_c, cmd) => `https://signed/${cmd.input.Key}`),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const cmd = (name: string) => jest.fn((input) => ({ name, input }));
  return {
    DynamoDBDocumentClient: { from: () => ({ send }) },
    GetCommand: cmd('Get'),
    PutCommand: cmd('Put'),
    QueryCommand: cmd('Query'),
    ScanCommand: cmd('Scan'),
    UpdateCommand: cmd('Update'),
  };
});

import { matchUserRoute } from '../lambda/shared/users';

process.env.USERS_TABLE_NAME = 'users';
process.env.USER_PROFILES_TABLE_NAME = 'profiles';
process.env.AVATAR_BUCKET = 'bucket';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handler } = require('../lambda/users-api');

const call = (
  httpMethod: string,
  path: string,
  claims: Record<string, unknown> | undefined,
  extra: Record<string, unknown> = {},
) => handler({ httpMethod, path, requestContext: { authorizer: { claims } }, ...extra });

const body = (res: { body: string }) => JSON.parse(res.body);

describe('matchUserRoute', () => {
  test.each([
    ['/user', { kind: 'self' }],
    ['/user/profile', { kind: 'selfProfile' }],
    ['/user/avatar', { kind: 'selfAvatar' }],
    ['/users/', { kind: 'collection' }],
    ['/users/u1', { kind: 'item', userId: 'u1' }],
    ['/users/u%201/profile', { kind: 'itemProfile', userId: 'u 1' }],
    ['/users/u1/avatar', { kind: 'itemAvatar', userId: 'u1' }],
  ])('%s', (path, expected) => expect(matchUserRoute(path)).toEqual(expected));

  test.each(['/', '/users/u1/other', '/admin/users/u1'])('%s is not a user route', (path) =>
    expect(matchUserRoute(path)).toBeNull(),
  );
});

describe('users-api handler', () => {
  beforeEach(() => send.mockReset());

  test('404 for an unknown route', async () => {
    expect((await call('GET', '/nope', { sub: 'u1' })).statusCode).toBe(404);
  });

  test('401 without a sub claim', async () => {
    const res = await call('GET', '/user', {});
    expect(res.statusCode).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  test('GET /user returns the merged profile wrapped in data', async () => {
    send
      .mockResolvedValueOnce({ Item: { userId: 'u1', email: 'a@b.c', avatarUrl: '' } })
      .mockResolvedValueOnce({ Item: { userId: 'u1', bio: 'hi', secret: 'x' } });
    const res = await call('GET', '/user', { sub: 'u1' });
    expect(res.statusCode).toBe(200);
    expect(body(res).data).toEqual({ userId: 'u1', email: 'a@b.c', avatarUrl: '', bio: 'hi' });
  });

  test('GET /users/{id} strips private fields for other users', async () => {
    send
      .mockResolvedValueOnce({ Item: { userId: 'u2', email: 'x@y.z', username: 'bob', groups: ['admins'] } })
      .mockResolvedValueOnce({ Item: undefined });
    const res = await call('GET', '/users/u2', { sub: 'u1' });
    expect(body(res).data).toEqual({ userId: 'u2', username: 'bob', avatarUrl: '' });
  });

  test('admins see private fields of other users', async () => {
    send
      .mockResolvedValueOnce({ Item: { userId: 'u2', email: 'x@y.z' } })
      .mockResolvedValueOnce({ Item: undefined });
    const res = await call('GET', '/users/u2', { sub: 'u1', 'cognito:groups': '[admins]' });
    expect(body(res).data.email).toBe('x@y.z');
  });

  test('404 when another user does not exist (no provisioning)', async () => {
    send.mockResolvedValue({ Item: undefined });
    const res = await call('GET', '/users/u2', { sub: 'u1' });
    expect(res.statusCode).toBe(404);
    expect(body(res).code).toBe('USER_NOT_FOUND');
    expect(send.mock.calls.some(([c]) => c.name === 'Put')).toBe(false);
  });

  test('GET /user provisions the caller on first access', async () => {
    send.mockImplementation(async (c: { name: string }) => ({ Item: undefined, name: c.name }));
    const res = await call('GET', '/user', { sub: 'u1', email: 'Jane@Example.com', given_name: 'Jane' });
    expect(res.statusCode).toBe(200);
    expect(body(res).data).toMatchObject({ userId: 'u1', email: 'jane@example.com', username: 'jane', tier: 'free' });
    expect(send.mock.calls.filter(([c]) => c.name === 'Put')).toHaveLength(2);
  });

  test('PUT /users/{id} is forbidden for a non-admin', async () => {
    const res = await call('PUT', '/users/u2', { sub: 'u1' }, { body: '{"firstName":"X"}' });
    expect(res.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  test('PUT /user updates only allow-listed fields and recomputes fullName', async () => {
    send
      .mockResolvedValueOnce({ Item: { firstName: 'A', lastName: 'B' } })
      .mockResolvedValueOnce({ Attributes: { userId: 'u1', fullName: 'Z B' } });
    const res = await call('PUT', '/user', { sub: 'u1' }, { body: JSON.stringify({ firstName: 'Z', tier: 'pro' }) });
    expect(res.statusCode).toBe(200);
    const update = send.mock.calls[1][0].input;
    expect(Object.keys(update.ExpressionAttributeNames)).toEqual(['#firstName', '#updatedAt', '#fullName']);
    expect(update.ExpressionAttributeValues[':fullName']).toBe('Z B');
  });

  test('PUT /user with no updatable fields is a 400', async () => {
    send.mockResolvedValue({});
    const res = await call('PUT', '/user/profile', { sub: 'u1' }, { body: '{"tier":"pro"}' });
    expect(res.statusCode).toBe(400);
    expect(body(res).code).toBe('NO_FIELDS');
  });

  test('invalid JSON body is a 400', async () => {
    const res = await call('PUT', '/user', { sub: 'u1' }, { body: '{oops' });
    expect(res.statusCode).toBe(400);
  });

  test('GET /users is admin only', async () => {
    expect((await call('GET', '/users', { sub: 'u1' })).statusCode).toBe(403);
    send.mockResolvedValue({ Items: [{ userId: 'u1' }] });
    const res = await call('GET', '/users', { sub: 'u1', 'cognito:groups': 'admins' }, { queryStringParameters: { limit: '5' } });
    expect(body(res).data).toEqual([{ userId: 'u1' }]);
    expect(send.mock.calls[0][0].input.Limit).toBe(5);
  });

  test('GET /users?username= returns the public projection', async () => {
    send.mockResolvedValue({ Items: [{ userId: 'u2', username: 'bob', email: 'x@y.z' }] });
    const res = await call('GET', '/users', { sub: 'u1' }, { queryStringParameters: { username: 'Bob' } });
    expect(body(res).data).toEqual({ userId: 'u2', username: 'bob', avatarUrl: '' });
    expect(send.mock.calls[0][0].input.ExpressionAttributeValues[':username']).toBe('bob');
  });

  test('POST /user/avatar returns a presigned upload url', async () => {
    const res = await call('POST', '/user/avatar', { sub: 'u1' }, { body: '{"contentType":"image/png"}' });
    const data = body(res).data;
    expect(res.statusCode).toBe(200);
    expect(data.avatarUrl).toMatch(/^u1-\d+\.png$/);
    expect(data.uploadUrl).toBe(`https://signed/avatars/${data.avatarUrl}`);
  });

  test('POST /user/avatar rejects unsupported content types', async () => {
    const res = await call('POST', '/user/avatar', { sub: 'u1' }, { body: '{"contentType":"image/gif"}' });
    expect(res.statusCode).toBe(400);
    expect(body(res).code).toBe('INVALID_CONTENT_TYPE');
  });

  test('unsupported method is a 405', async () => {
    expect((await call('DELETE', '/user', { sub: 'u1' })).statusCode).toBe(405);
  });

  test('unexpected errors are masked as 500', async () => {
    send.mockRejectedValue(new Error('boom'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await call('GET', '/user', { sub: 'u1' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('boom');
  });
});
