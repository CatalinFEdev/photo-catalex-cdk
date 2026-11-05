import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CatalogService, matchCatalogRoute } from './shared/catalog';
import { originOf, response } from './shared/response';
import { UserClaims, UserRequestError } from './shared/users';

export interface CatalogApiEvent {
  httpMethod?: string;
  path?: string;
  body?: string | null;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  requestContext?: { authorizer?: { claims?: UserClaims } };
}

const service = new CatalogService(
  DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
  {
    categories: process.env.CATEGORIES_TABLE_NAME!,
    pictures: process.env.PICTURES_TABLE_NAME!,
  },
);

const parseBody = (event: CatalogApiEvent): Record<string, unknown> => {
  if (!event.body) return {};
  try {
    const parsed = JSON.parse(event.body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    /* handled below */
  }
  throw new UserRequestError('Request body must be a JSON object.', 400, 'INVALID_BODY');
};

export const handler = async (event: CatalogApiEvent) => {
  const origin = originOf(event);
  const send = (status: number, body: unknown) => response(status, body, origin);

  const route = matchCatalogRoute(event.path ?? '');
  if (!route) return send(404, { message: 'Not found.', code: 'NOT_FOUND' });

  const method = event.httpMethod ?? 'GET';
  const claims = event.requestContext?.authorizer?.claims ?? {};
  const { resource, id } = route;

  try {
    if (!id) {
      if (method === 'GET') {
        return send(200, { data: await service.list(resource, claims, event.queryStringParameters ?? {}) });
      }
      if (method === 'POST') return send(201, { data: await service.create(resource, claims, parseBody(event)) });
      if (method === 'PUT') {
        // The Angular admin sends the id in the body of a collection PUT
        const body = parseBody(event);
        if (body.id === undefined || body.id === null) {
          throw new UserRequestError('"id" is required.', 400, 'INVALID_FIELD');
        }
        return send(200, { data: await service.update(resource, claims, String(body.id), body) });
      }
    } else {
      if (method === 'GET') return send(200, { data: await service.get(resource, claims, id) });
      if (method === 'PUT' || method === 'PATCH') {
        return send(200, { data: await service.update(resource, claims, id, parseBody(event)) });
      }
    }

    return send(405, { message: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' });
  } catch (error) {
    if (error instanceof UserRequestError) {
      return send(error.statusCode, { message: error.message, code: error.code });
    }
    console.error('Catalog request failed', error);
    return send(500, { message: 'Unable to process the request.', code: 'INTERNAL_ERROR' });
  }
};
