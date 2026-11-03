const send = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send }) },
  GetCommand: jest.fn((input) => ({ input })),
}));

const cases = [
  { name: 'get-user', envVar: 'USERS_TABLE_NAME', table: 'users-table', notFound: 'User not found' },
  { name: 'get-user-profile', envVar: 'USER_PROFILES_TABLE_NAME', table: 'profiles-table', notFound: 'Profile not found' },
];

describe.each(cases)('$name handler', ({ name, envVar, table, notFound }) => {
  let handler: (event: unknown) => Promise<{ statusCode: number; body: string }>;

  const event = (claims: Record<string, string> | undefined, userId?: string) => ({
    pathParameters: userId ? { userId } : undefined,
    requestContext: { authorizer: { claims } },
  });

  beforeAll(() => {
    process.env[envVar] = table;
    handler = require(`../lambda/${name}`).handler;
  });

  beforeEach(() => send.mockReset());

  test('401 without a sub claim', async () => {
    const res = await handler(event({}));
    expect(res.statusCode).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  test('403 when a non-admin requests another user', async () => {
    const res = await handler(event({ sub: 'u1' }, 'u2'));
    expect(res.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  test('regular user reads own data using the token sub', async () => {
    send.mockResolvedValue({ Item: { userId: 'u1' } });
    const res = await handler(event({ sub: 'u1' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ userId: 'u1' });
    expect(send.mock.calls[0][0].input).toEqual({ TableName: table, Key: { userId: 'u1' } });
  });

  test('admin can read another user', async () => {
    send.mockResolvedValue({ Item: { userId: 'u2' } });
    const res = await handler(event({ sub: 'u1', 'cognito:groups': 'admins' }, 'u2'));
    expect(res.statusCode).toBe(200);
    expect(send.mock.calls[0][0].input.Key).toEqual({ userId: 'u2' });
  });

  test('404 when the item does not exist', async () => {
    send.mockResolvedValue({});
    const res = await handler(event({ sub: 'u1' }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).message).toBe(notFound);
  });
});
