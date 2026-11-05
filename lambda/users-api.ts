import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { originOf, response } from './shared/response';
import { callerUserId, matchUserRoute, UserClaims, UserRequestError, UserService } from './shared/users';

export interface UsersApiEvent {
  httpMethod?: string;
  path?: string;
  body?: string | null;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  requestContext?: { authorizer?: { claims?: UserClaims } };
}

const service = new UserService(
  DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
  new S3Client({}),
  {
    usersTable: process.env.USERS_TABLE_NAME!,
    profilesTable: process.env.USER_PROFILES_TABLE_NAME!,
    avatarBucket: process.env.AVATAR_BUCKET!,
    avatarCdnDomain: process.env.AVATAR_CDN_DOMAIN || undefined,
  },
);

const parseBody = (event: UsersApiEvent): Record<string, unknown> => {
  if (!event.body) return {};
  try {
    const parsed = JSON.parse(event.body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    /* handled below */
  }
  throw new UserRequestError('Request body must be a JSON object.', 400, 'INVALID_BODY');
};

export const handler = async (event: UsersApiEvent) => {
  const origin = originOf(event);
  const send = (status: number, body: unknown) => response(status, body, origin);

  const route = matchUserRoute(event.path ?? '');
  if (!route) return send(404, { message: 'Not found.', code: 'NOT_FOUND' });

  const method = event.httpMethod ?? 'GET';
  const claims = event.requestContext?.authorizer?.claims ?? {};
  const query = event.queryStringParameters ?? {};

  try {
    // Username lookup is secured by the API authorizer like every other route
    if (route.kind === 'collection' && method === 'GET' && query.username) {
      return send(200, { data: await service.getUserByUsername(query.username) });
    }

    const caller = callerUserId(claims);
    const target = 'userId' in route ? route.userId : caller;
    const isWrite = method === 'PUT' || method === 'PATCH';

    switch (route.kind) {
      case 'collection':
        if (method === 'GET') return send(200, { data: await service.listUsers(claims, Number(query.limit ?? 100)) });
        if (method === 'POST') return send(201, { data: await service.createUser(claims, parseBody(event)) });
        break;
      case 'self':
      case 'item':
        if (method === 'GET') return send(200, { data: await service.getUser(target, claims) });
        if (method === 'POST') return send(201, { data: await service.createUser(claims, parseBody(event)) });
        if (isWrite) return send(200, { data: await service.updateUserData(target, claims, parseBody(event)) });
        break;
      case 'selfProfile':
      case 'itemProfile':
        if (isWrite || method === 'POST') {
          return send(200, { data: await service.updateSocialProfile(target, claims, parseBody(event)) });
        }
        break;
      case 'selfAvatar':
      case 'itemAvatar':
        if (method === 'POST') return send(200, { data: await service.getAvatarUploadUrl(target, claims, parseBody(event)) });
        break;
    }

    return send(405, { message: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' });
  } catch (error) {
    if (error instanceof UserRequestError) {
      return send(error.statusCode, { message: error.message, code: error.code });
    }
    console.error('User request failed', error);
    return send(500, { message: 'Unable to process the request.', code: 'INTERNAL_ERROR' });
  }
};
