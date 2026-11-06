const send = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn() }));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const cmd = (name: string) => jest.fn((input) => ({ name, input }));
  return {
    DynamoDBDocumentClient: { from: () => ({ send }) },
    GetCommand: cmd('Get'),
    PutCommand: cmd('Put'),
    ScanCommand: cmd('Scan'),
    UpdateCommand: cmd('Update'),
  };
});

import { matchCatalogRoute } from '../lambda/shared/catalog';

process.env.CATEGORIES_TABLE_NAME = 'cats';
process.env.PICTURES_TABLE_NAME = 'pics';
process.env.ART_CATEGORIES_TABLE_NAME = 'art-cats';
process.env.ART_PICTURES_TABLE_NAME = 'art-pics';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handler } = require('../lambda/catalog-api');

const admin = { sub: 'admin-1', 'cognito:groups': ['admins'] };
const member = { sub: 'user-1' };

const call = (
  httpMethod: string,
  path: string,
  claims: Record<string, unknown> | undefined,
  extra: Record<string, unknown> = {},
) => handler({ httpMethod, path, requestContext: { authorizer: { claims } }, ...extra });

const body = (res: { body: string }) => JSON.parse(res.body);

beforeEach(() => send.mockReset());

describe('matchCatalogRoute', () => {
  test('matches collections and items', () => {
    expect(matchCatalogRoute('/photo-categories')).toEqual({ resource: 'categories' });
    expect(matchCatalogRoute('/photo-pictures/12/')).toEqual({ resource: 'pictures', id: '12' });
    expect(matchCatalogRoute('/photo-pictures/1/2')).toBeNull();
    expect(matchCatalogRoute('/categories/3')).toEqual({ resource: 'artCategories', id: '3' });
    expect(matchCatalogRoute('/pictures/7')).toEqual({ resource: 'artPictures', id: '7' });
    expect(matchCatalogRoute('/other')).toBeNull();
  });
});

describe('art categories', () => {
  test('non-admins cannot write', async () => {
    const res = await call('POST', '/categories', member, { body: JSON.stringify({ translationKey: 'x' }) });
    expect(res.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  test('admin creates an art category in the categories table', async () => {
    send.mockResolvedValueOnce({ Items: [{ id: 1 }] }).mockResolvedValueOnce({});
    const res = await call('POST', '/categories', admin, { body: JSON.stringify({ translationKey: 'x' }) });
    expect(res.statusCode).toBe(201);
    expect(send.mock.calls[1][0].input.TableName).toBe('art-cats');
    expect(body(res).data.siteType).toBe('art');
  });
});

describe('art pictures', () => {
  test('non-admins cannot write', async () => {
    const res = await call('POST', '/pictures', member, { body: JSON.stringify({ translationKey: 'x', categoryId: 1 }) });
    expect(res.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  test('admin creates a picture in the pictures table', async () => {
    send.mockResolvedValueOnce({ Items: [{ id: '4' }] }).mockResolvedValueOnce({});
    const res = await call('POST', '/pictures', admin, { body: JSON.stringify({ translationKey: 'x', categoryId: 2 }) });
    expect(res.statusCode).toBe(201);
    expect(send.mock.calls[1][0].input.TableName).toBe('art-pics');
    expect(body(res).data).toMatchObject({ id: '5', categoryId: 2 });
  });

  test('lists the pictures table filtered by categoryId, with string keys', async () => {
    send.mockResolvedValueOnce({ Items: [] }).mockResolvedValueOnce({ Item: { id: '9' } });
    await call('GET', '/pictures', member, { queryStringParameters: { categoryId: '3' } });
    await call('GET', '/pictures/9', member);
    expect(send.mock.calls[0][0].input.TableName).toBe('art-pics');
    expect(send.mock.calls[0][0].input.ExpressionAttributeValues).toEqual({ ':categoryId': 3 });
    expect(send.mock.calls[1][0].input.Key).toEqual({ id: '9' });
  });

  test('photo-pictures still targets the app2 table', async () => {
    send.mockResolvedValueOnce({ Items: [] });
    await call('GET', '/photo-pictures', member);
    expect(send.mock.calls[0][0].input.TableName).toBe('pics');
  });
});

describe('catalog API', () => {
  test('unknown route returns 404', async () => {
    expect((await call('GET', '/nope', member)).statusCode).toBe(404);
  });

  test('missing identity returns 401', async () => {
    expect((await call('GET', '/photo-categories', {})).statusCode).toBe(401);
  });

  test('any signed-in user lists categories sorted by position', async () => {
    send.mockResolvedValueOnce({ Items: [{ id: 2, positionId: 5 }, { id: 1, positionId: 1 }] });
    const res = await call('GET', '/photo-categories', member);
    expect(res.statusCode).toBe(200);
    expect(body(res).data.map((c: { id: number }) => c.id)).toEqual([1, 2]);
  });

  test('pictures can be filtered by categoryId', async () => {
    send.mockResolvedValueOnce({ Items: [] });
    await call('GET', '/photo-pictures', member, { queryStringParameters: { categoryId: '8' } });
    expect(send.mock.calls[0][0].input.ExpressionAttributeValues).toEqual({ ':categoryId': 8 });
  });

  test('categories use numeric keys, pictures string keys', async () => {
    send.mockResolvedValue({ Item: { id: 1 } });
    await call('GET', '/photo-categories/7', member);
    await call('GET', '/photo-pictures/92', member);
    expect(send.mock.calls[0][0].input.Key).toEqual({ id: 7 });
    expect(send.mock.calls[1][0].input.Key).toEqual({ id: '92' });
  });

  test('invalid category id returns 400, missing item 404', async () => {
    expect((await call('GET', '/photo-categories/abc', member)).statusCode).toBe(400);
    send.mockResolvedValueOnce({});
    expect((await call('GET', '/photo-pictures/1', member)).statusCode).toBe(404);
  });

  test('non-admins cannot write', async () => {
    const res = await call('POST', '/photo-categories', member, { body: JSON.stringify({ translationKey: 'x' }) });
    expect(res.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  test('admin creates a category with the next numeric id', async () => {
    send.mockResolvedValueOnce({ Items: [{ id: 3 }, { id: 7 }] }).mockResolvedValueOnce({});
    const res = await call('POST', '/photo-categories', admin, {
      body: JSON.stringify({ translationKey: 'birds', active: 1, positionId: '4' }),
    });
    expect(res.statusCode).toBe(201);
    expect(body(res).data).toMatchObject({ id: 8, translationKey: 'birds', active: '1', positionId: 4, userId: 'admin-1' });
    expect(send.mock.calls[1][0].input.ConditionExpression).toBe('attribute_not_exists(id)');
  });

  test('admin creates a picture with a string id and numeric flag', async () => {
    send.mockResolvedValueOnce({ Items: [{ id: '92' }] }).mockResolvedValueOnce({});
    const res = await call('POST', '/photo-pictures', admin, {
      body: JSON.stringify({ translationKey: 'chamois2', categoryId: 8, active: '1' }),
    });
    expect(body(res).data).toMatchObject({ id: '93', categoryId: 8, active: 1 });
  });

  test('retries on id conflict', async () => {
    const conflict = Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' });
    send
      .mockResolvedValueOnce({ Items: [{ id: 1 }] })
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ Items: [{ id: 1 }, { id: 2 }] })
      .mockResolvedValueOnce({});
    const res = await call('POST', '/photo-categories', admin, { body: JSON.stringify({ translationKey: 'a' }) });
    expect(body(res).data.id).toBe(3);
  });

  test('validation errors return 400', async () => {
    expect((await call('POST', '/photo-categories', admin, { body: '{}' })).statusCode).toBe(400);
    const bad = await call('POST', '/photo-pictures', admin, {
      body: JSON.stringify({ translationKey: 'a', categoryId: 'x' }),
    });
    expect(bad.statusCode).toBe(400);
    expect((await call('POST', '/photo-categories', admin, { body: '[1]' })).statusCode).toBe(400);
  });

  test('admin updates by id in the path (PATCH) and ignores unknown fields', async () => {
    send.mockResolvedValueOnce({ Attributes: { id: 7, active: '1' } });
    const res = await call('PATCH', '/photo-categories/7', admin, {
      body: JSON.stringify({ active: 1, userId: 'hacker' }),
    });
    expect(res.statusCode).toBe(200);
    const input = send.mock.calls[0][0].input;
    expect(input.UpdateExpression).toBe('SET #active = :active');
    expect(input.ExpressionAttributeValues).toEqual({ ':active': '1' });
  });

  test('collection PUT takes the id from the body', async () => {
    send.mockResolvedValueOnce({ Attributes: { id: 7 } });
    const res = await call('PUT', '/photo-categories', admin, { body: JSON.stringify({ id: 7, positionId: 2 }) });
    expect(res.statusCode).toBe(200);
    expect(send.mock.calls[0][0].input.Key).toEqual({ id: 7 });
    expect((await call('PUT', '/photo-categories', admin, { body: '{}' })).statusCode).toBe(400);
  });

  test('update of a missing item returns 404; empty update 400', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' }));
    expect((await call('PUT', '/photo-pictures/1', admin, { body: JSON.stringify({ active: 1 }) })).statusCode).toBe(404);
    expect((await call('PUT', '/photo-pictures/1', admin, { body: '{}' })).statusCode).toBe(400);
  });

  test('unsupported methods return 405 and DB errors 500', async () => {
    expect((await call('DELETE', '/photo-categories/1', admin)).statusCode).toBe(405);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    send.mockRejectedValueOnce(new Error('boom'));
    expect((await call('GET', '/photo-categories', member)).statusCode).toBe(500);
  });
});
