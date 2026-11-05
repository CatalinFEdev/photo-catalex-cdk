import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { matchOriginalsRoute, OriginalsService } from './shared/originals';
import { originOf, response } from './shared/response';
import { UserClaims, UserRequestError } from './shared/users';

export interface OriginalsApiEvent {
  httpMethod?: string;
  path?: string;
  body?: string | null;
  headers?: Record<string, string | undefined>;
  requestContext?: { authorizer?: { claims?: UserClaims } };
}

const service = new OriginalsService(
  DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
  new S3Client({}),
  { table: process.env.ORIGINALS_TABLE_NAME!, originalsBucket: process.env.ORIGINALS_BUCKET! },
);

const parseBody = (event: OriginalsApiEvent): Record<string, unknown> => {
  if (!event.body) return {};
  try {
    const parsed = JSON.parse(event.body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    /* handled below */
  }
  throw new UserRequestError('Request body must be a JSON object.', 400, 'INVALID_BODY');
};

export const handler = async (event: OriginalsApiEvent) => {
  const origin = originOf(event);
  const send = (status: number, body: unknown) => response(status, body, origin);

  const route = matchOriginalsRoute(event.path ?? '');
  if (!route) return send(404, { message: 'Not found.', code: 'NOT_FOUND' });

  const method = event.httpMethod ?? 'GET';
  const claims = event.requestContext?.authorizer?.claims ?? {};

  try {
    if (route.upload) {
      if (method === 'GET') return send(200, { data: await service.list(claims) });
      if (method === 'POST') return send(201, { data: await service.createUpload(claims, parseBody(event)) });
    } else if (method === 'GET') {
      return send(200, { data: await service.get(claims, route.id!) });
    }
    return send(405, { message: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' });
  } catch (error) {
    if (error instanceof UserRequestError) {
      return send(error.statusCode, { message: error.message, code: error.code });
    }
    console.error('Originals request failed', error);
    return send(500, { message: 'Unable to process the request.', code: 'INTERNAL_ERROR' });
  }
};
