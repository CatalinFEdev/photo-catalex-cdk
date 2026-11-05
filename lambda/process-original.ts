import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { Readable } from 'stream';
import sharp from 'sharp';
import { extractExif } from './shared/exif';

export const MAX_LONG_SIDE = 1000;
const EXIF_HEADER_BYTES = 2 * 1024 * 1024;

interface S3Event {
  Records: { s3: { bucket: { name: string }; object: { key: string } } }[];
}

interface EventBridgeEvent {
  detail: { bucket: { name: string }; object: { key: string } };
}

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

const table = () => process.env.ORIGINALS_TABLE_NAME!;
const picturesBucket = () => process.env.PICTURES_BUCKET!;

const setStatus = (id: string, values: Record<string, unknown>) => {
  const names = Object.keys(values);
  return ddb.send(
    new UpdateCommand({
      TableName: table(),
      Key: { id },
      UpdateExpression: 'SET ' + names.map((n) => `#${n} = :${n}`).join(', '),
      ConditionExpression: 'attribute_exists(id)',
      ExpressionAttributeNames: Object.fromEntries(names.map((n) => [`#${n}`, n])),
      ExpressionAttributeValues: Object.fromEntries(names.map((n) => [`:${n}`, values[n]])),
    }),
  );
};

const processObject = async (bucket: string, key: string) => {
  // Keys are `<originalId>/<fileName>`; anything else is not an upload of ours
  const [id] = key.split('/');
  if (!id || !key.includes('/')) return;

  await setStatus(id, { status: 'processing' });
  try {
    const [object, head] = await Promise.all([
      s3.send(new GetObjectCommand({ Bucket: bucket, Key: key })),
      s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${EXIF_HEADER_BYTES - 1}` })),
    ]);
    const exif = await extractExif(await head.Body!.transformToByteArray());

    // Streamed through sharp, so memory does not grow with the size of the original
    const pipeline = sharp({ limitInputPixels: false, sequentialRead: true });
    const metadata = pipeline.clone().metadata();
    const resized = pipeline
      .clone()
      .rotate()
      .resize({ width: MAX_LONG_SIDE, height: MAX_LONG_SIDE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    (object.Body as Readable).pipe(pipeline);
    const [meta, { data, info }] = await Promise.all([metadata, resized]);

    const pictureKey = `${id}/0.jpg`;
    await s3.send(
      new PutObjectCommand({
        Bucket: picturesBucket(),
        Key: pictureKey,
        Body: data,
        ContentType: 'image/jpeg',
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );

    const swapped = (meta.orientation ?? 1) >= 5;
    await setStatus(id, {
      status: 'ready',
      size: object.ContentLength,
      width: swapped ? meta.height : meta.width,
      height: swapped ? meta.width : meta.height,
      pictureKey,
      pictureWidth: info.width,
      pictureHeight: info.height,
      exif,
      processedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Processing failed', { key, error });
    await setStatus(id, { status: 'failed', error: String((error as Error)?.message ?? error).slice(0, 500) });
  }
};

export const handler = async (event: S3Event | EventBridgeEvent) => {
  if ('detail' in event) {
    // EventBridge keys are not URL-encoded
    await processObject(event.detail.bucket.name, event.detail.object.key);
    return;
  }
  for (const record of event.Records) {
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    await processObject(record.s3.bucket.name, key);
  }
};
