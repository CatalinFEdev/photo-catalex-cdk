const send = jest.fn();
const getSignedUrl = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(),
  PutObjectCommand: jest.fn((input) => ({ name: 'PutObject', input })),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: (...args: unknown[]) => getSignedUrl(...args) }));
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const cmd = (name: string) => jest.fn((input) => ({ name, input }));
  return {
    DynamoDBDocumentClient: { from: () => ({ send }) },
    GetCommand: cmd('Get'),
    PutCommand: cmd('Put'),
    ScanCommand: cmd('Scan'),
  };
});

import { matchOriginalsRoute, safeFileName } from '../lambda/shared/originals';
import { sanitizeExif } from '../lambda/shared/exif';

process.env.ORIGINALS_TABLE_NAME = 'photo-originals';
process.env.ORIGINALS_BUCKET = 'photo-originals';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handler } = require('../lambda/originals-api');

const admin = { sub: 'admin-1', 'cognito:groups': ['admins'] };
const member = { sub: 'user-1' };
const call = (httpMethod: string, path: string, claims: Record<string, unknown> | undefined, body?: unknown) =>
  handler({
    httpMethod,
    path,
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: { authorizer: { claims } },
  });

beforeEach(() => {
  send.mockReset();
  getSignedUrl.mockReset();
});

describe('routes and helpers', () => {
  test('matchOriginalsRoute', () => {
    expect(matchOriginalsRoute('/photo-originals')).toEqual({ upload: true });
    expect(matchOriginalsRoute('/photo-originals/abc/')).toEqual({ id: 'abc', upload: false });
    expect(matchOriginalsRoute('/photo-pictures')).toBeNull();
  });

  test('safeFileName strips paths and unsafe characters', () => {
    expect(safeFileName('..\\..\\evil/my photo?.jpg')).toBe('my photo_.jpg');
  });

  test('sanitizeExif converts dates and drops unsupported values', () => {
    const result = sanitizeExif({
      Make: 'Canon\0',
      DateTimeOriginal: new Date('2024-05-01T10:00:00Z'),
      FNumber: 2.8,
      Bad: NaN,
      Empty: '  ',
      Thumbnail: new Uint8Array(5000),
    });
    expect(result).toEqual({ Make: 'Canon', DateTimeOriginal: '2024-05-01T10:00:00.000Z', FNumber: 2.8 });
  });
});

describe('POST /photo-originals', () => {
  test('admin gets a presigned URL, without any size restriction, and a pending record', async () => {
    send.mockResolvedValue({});
    getSignedUrl.mockResolvedValue('https://signed');
    const res = await call('POST', '/photo-originals', admin, { fileName: 'IMG 1.jpg', contentType: 'image/jpeg' });
    const data = JSON.parse(res.body).data;

    expect(res.statusCode).toBe(201);
    expect(data).toMatchObject({ status: 'pending', uploadUrl: 'https://signed', fileName: 'IMG 1.jpg' });
    expect(data.originalKey).toBe(`${data.id}/IMG 1.jpg`);
    expect(send.mock.calls[0][0].input.Item.status).toBe('pending');
    expect(getSignedUrl.mock.calls[0][1].input).not.toHaveProperty('ContentLength');
  });

  test('non admins are rejected', async () => {
    const res = await call('POST', '/photo-originals', member, { fileName: 'a.jpg', contentType: 'image/jpeg' });
    expect(res.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  test('only image content types are accepted', async () => {
    const res = await call('POST', '/photo-originals', admin, { fileName: 'a.exe', contentType: 'application/zip' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /photo-originals', () => {
  test('lists newest first', async () => {
    send.mockResolvedValue({
      Items: [
        { id: 'a', createdAt: '2024-01-01' },
        { id: 'b', createdAt: '2024-02-01' },
      ],
    });
    const res = await call('GET', '/photo-originals', member);
    expect(JSON.parse(res.body).data.map((i: { id: string }) => i.id)).toEqual(['b', 'a']);
  });

  test('returns 404 for unknown ids and 401-style error without a token', async () => {
    send.mockResolvedValue({});
    expect((await call('GET', '/photo-originals/x', member)).statusCode).toBe(404);
    expect((await call('GET', '/photo-originals/x', undefined)).statusCode).toBeGreaterThanOrEqual(400);
  });
});
