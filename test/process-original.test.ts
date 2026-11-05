import { Readable } from 'stream';
import sharp from 'sharp';

const s3Send = jest.fn();
const ddbSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: s3Send })),
  GetObjectCommand: jest.fn((input) => ({ name: 'Get', input })),
  PutObjectCommand: jest.fn((input) => ({ name: 'Put', input })),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: ddbSend }) },
  UpdateCommand: jest.fn((input) => ({ name: 'Update', input })),
}));

process.env.ORIGINALS_TABLE_NAME = 'photo-originals';
process.env.PICTURES_BUCKET = 'photo-pictures';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handler } = require('../lambda/process-original');

const event = (key: string) => ({ Records: [{ s3: { bucket: { name: 'photo-originals' }, object: { key } } }] });

const mockObject = (file: Buffer) =>
  s3Send.mockImplementation(async (command: { name: string; input: { Range?: string } }) => {
    if (command.name === 'Get') {
      return command.input.Range
        ? { Body: { transformToByteArray: async () => new Uint8Array(file.subarray(0, 2 * 1024 * 1024)) } }
        : { Body: Readable.from([file]), ContentLength: file.length };
    }
    return {};
  });

const statuses = () => ddbSend.mock.calls.map(([c]) => c.input.ExpressionAttributeValues[':status']);

beforeEach(() => {
  s3Send.mockReset();
  ddbSend.mockReset().mockResolvedValue({});
});

describe('process-original', () => {
  test('resizes the long side to 1000px, stores the copy in photo-pictures and updates the record', async () => {
    const file = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#336699' } })
      .jpeg()
      .withExif({ IFD0: { Make: 'TestCam' } })
      .toBuffer();
    mockObject(file);

    await handler(event('abc/My+photo.jpg'));

    const put = s3Send.mock.calls.map(([c]) => c).find((c) => c.name === 'Put');
    expect(put.input).toMatchObject({ Bucket: 'photo-pictures', Key: 'abc/0.jpg', ContentType: 'image/jpeg' });
    const out = await sharp(put.input.Body).metadata();
    expect([out.width, out.height]).toEqual([1000, 667]);

    expect(statuses()).toEqual(['processing', 'ready']);
    const values = ddbSend.mock.calls[1][0].input.ExpressionAttributeValues;
    expect(values).toMatchObject({
      ':width': 3000,
      ':height': 2000,
      ':pictureKey': 'abc/0.jpg',
      ':pictureWidth': 1000,
      ':pictureHeight': 667,
      ':size': file.length,
    });
    expect(values[':exif']).toMatchObject({ Make: 'TestCam' });
    expect(s3Send.mock.calls[0][0].input.Key).toBe('abc/My photo.jpg');
  });

  test('does not enlarge small images', async () => {
    mockObject(await sharp({ create: { width: 400, height: 300, channels: 3, background: '#fff' } }).jpeg().toBuffer());
    await handler(event('small/a.jpg'));
    const put = s3Send.mock.calls.map(([c]) => c).find((c) => c.name === 'Put');
    expect((await sharp(put.input.Body).metadata()).width).toBe(400);
  });

  test('marks the record as failed when the file is not an image', async () => {
    mockObject(Buffer.from('not an image'));
    await handler(event('bad/a.jpg'));
    expect(statuses()).toEqual(['processing', 'failed']);
  });

  test('accepts EventBridge events (keys are not URL-encoded)', async () => {
    mockObject(await sharp({ create: { width: 100, height: 100, channels: 3, background: '#fff' } }).jpeg().toBuffer());
    await handler({ detail: { bucket: { name: 'photo-pictures-originals' }, object: { key: 'eb/a+b.jpg' } } });
    expect(s3Send.mock.calls[0][0].input).toMatchObject({ Bucket: 'photo-pictures-originals', Key: 'eb/a+b.jpg' });
    expect(statuses()).toEqual(['processing', 'ready']);
  });

  test('ignores objects that are not <id>/<file>', async () => {
    await handler(event('stray.jpg'));
    expect(ddbSend).not.toHaveBeenCalled();
  });
});
