import { randomUUID } from 'crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { callerUserId, isAdmin, UserClaims, UserRequestError } from './users';

export const UPLOAD_URL_TTL_SECONDS = 3600;
const MAX_SCAN_PAGES = 20;

export type OriginalsRoute = { id?: string; upload: boolean };

export const matchOriginalsRoute = (path: string): OriginalsRoute | null => {
  const match = /^\/photo-originals(?:\/([^/]+))?$/.exec(path.replace(/\/+$/, ''));
  if (!match) return null;
  return match[1] ? { id: decodeURIComponent(match[1]), upload: false } : { upload: true };
};

export const safeFileName = (name: string) =>
  name
    .split(/[\\/]/)
    .pop()!
    .replace(/[^\w.\- ]+/g, '_')
    .trim()
    .slice(0, 120);

const invalid = (message: string) => new UserRequestError(message, 400, 'INVALID_FIELD');

export class OriginalsService {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly s3: S3Client,
    private readonly config: { table: string; originalsBucket: string },
  ) {}

  /** No size limit is enforced: the browser uploads straight to S3 with a presigned URL. */
  async createUpload(claims: UserClaims, body: Record<string, unknown>) {
    const userId = callerUserId(claims);
    if (!isAdmin(claims)) throw new UserRequestError('Forbidden.', 403, 'FORBIDDEN');

    if (typeof body.fileName !== 'string' || !safeFileName(body.fileName)) throw invalid('"fileName" is required.');
    if (typeof body.contentType !== 'string' || !/^image\/[\w.+-]+$/.test(body.contentType)) {
      throw invalid('"contentType" must be an image/* type.');
    }

    const fileName = safeFileName(body.fileName);
    const id = randomUUID();
    const originalKey = `${id}/${fileName}`;
    const item = {
      id,
      userId,
      fileName,
      contentType: body.contentType,
      originalKey,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    await this.ddb.send(
      new PutCommand({ TableName: this.config.table, Item: item, ConditionExpression: 'attribute_not_exists(id)' }),
    );

    const uploadUrl = await getSignedUrl(
      this.s3,
      new PutObjectCommand({ Bucket: this.config.originalsBucket, Key: originalKey, ContentType: body.contentType }),
      { expiresIn: UPLOAD_URL_TTL_SECONDS },
    );
    return { ...item, uploadUrl, expiresIn: UPLOAD_URL_TTL_SECONDS };
  }

  async get(claims: UserClaims, id: string) {
    callerUserId(claims);
    const result = await this.ddb.send(new GetCommand({ TableName: this.config.table, Key: { id } }));
    if (!result.Item) throw new UserRequestError('Not found.', 404, 'NOT_FOUND');
    return result.Item;
  }

  async list(claims: UserClaims) {
    callerUserId(claims);
    const items: Record<string, unknown>[] = [];
    let startKey: Record<string, unknown> | undefined;
    for (let page = 0; page < MAX_SCAN_PAGES; page++) {
      const result = await this.ddb.send(new ScanCommand({ TableName: this.config.table, ExclusiveStartKey: startKey }));
      items.push(...((result.Items ?? []) as Record<string, unknown>[]));
      startKey = result.LastEvaluatedKey;
      if (!startKey) break;
    }
    return items.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  }
}
