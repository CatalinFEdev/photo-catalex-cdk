import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { callerUserId, isAdmin, UserClaims, UserRequestError } from './users';

type FieldType = 'string' | 'number' | 'flagString' | 'flagNumber' | 'stringArray' | 'siteType';

interface ResourceSpec {
  /** Key type of the existing table (categories use a Number key, pictures a String key). */
  idType: 'number' | 'string';
  fields: Record<string, FieldType>;
  required: string[];
  defaults: Record<string, unknown>;
}

export type CatalogResource = 'categories' | 'pictures';

const SPECS: Record<CatalogResource, ResourceSpec> = {
  categories: {
    idType: 'number',
    fields: {
      translationKey: 'string',
      parentId: 'string',
      projectId: 'string',
      siteType: 'siteType',
      positionId: 'number',
      active: 'flagString',
      carouselList: 'stringArray',
      fileExt: 'string',
    },
    required: ['translationKey'],
    defaults: { parentId: '0', projectId: 'photo-catalinalexandru', siteType: 'photo', active: '0', carouselList: [], fileExt: 'jpg' },
  },
  pictures: {
    idType: 'string',
    fields: {
      translationKey: 'string',
      fileName: 'string',
      fileExt: 'string',
      categoryId: 'number',
      subcategoryId: 'number',
      positionId: 'number',
      active: 'flagNumber',
      width: 'number',
      height: 'number',
      badges: 'stringArray',
    },
    required: ['translationKey', 'categoryId'],
    defaults: { subcategoryId: 0, active: 0, badges: [], fileExt: 'jpg' },
  },
};

export type CatalogRoute = { resource: CatalogResource; id?: string };

export const matchCatalogRoute = (path: string): CatalogRoute | null => {
  const match = /^\/photo-(categories|pictures)(?:\/([^/]+))?$/.exec(path.replace(/\/+$/, ''));
  if (!match) return null;
  return {
    resource: match[1] as CatalogResource,
    ...(match[2] ? { id: decodeURIComponent(match[2]) } : {}),
  };
};

const invalid = (message: string) => new UserRequestError(message, 400, 'INVALID_FIELD');

const parseField = (name: string, type: FieldType, value: unknown): unknown => {
  switch (type) {
    case 'string': {
      if (typeof value !== 'string' || !value.trim()) throw invalid(`"${name}" must be a non-empty string.`);
      return value.trim();
    }
    case 'number': {
      const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
      if (typeof parsed !== 'number' || !Number.isFinite(parsed)) throw invalid(`"${name}" must be a number.`);
      return parsed;
    }
    case 'flagString':
    case 'flagNumber': {
      if (![0, 1, '0', '1', true, false].includes(value as never)) throw invalid(`"${name}" must be 0 or 1.`);
      const flag = value === 1 || value === '1' || value === true ? 1 : 0;
      return type === 'flagString' ? String(flag) : flag;
    }
    case 'stringArray': {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw invalid(`"${name}" must be an array of strings.`);
      }
      return value.map((entry: string) => entry.trim()).filter(Boolean);
    }
    case 'siteType': {
      if (value !== 'art' && value !== 'photo') throw invalid(`"${name}" must be "art" or "photo".`);
      return value;
    }
  }
};

const pickFields = (spec: ResourceSpec, body: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(spec.fields)
      .filter(([name]) => body[name] !== undefined)
      .map(([name, type]) => [name, parseField(name, type, body[name])]),
  );

const isConditionalFailure = (error: unknown) =>
  (error as { name?: string })?.name === 'ConditionalCheckFailedException';

const MAX_ID_ATTEMPTS = 3;
const MAX_SCAN_PAGES = 20;

export class CatalogService {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly tables: Record<CatalogResource, string>,
  ) {}

  private key(resource: CatalogResource, rawId: string) {
    const spec = SPECS[resource];
    if (spec.idType === 'string') return rawId;
    const id = Number(rawId);
    if (!rawId.trim() || !Number.isInteger(id) || id < 0) throw invalid('"id" must be a non-negative integer.');
    return id;
  }

  private requireAdmin(claims: UserClaims) {
    callerUserId(claims);
    if (!isAdmin(claims)) throw new UserRequestError('Forbidden.', 403, 'FORBIDDEN');
  }

  private async scanAll(resource: CatalogResource, extra: Record<string, unknown> = {}) {
    const items: Record<string, unknown>[] = [];
    let startKey: Record<string, unknown> | undefined;
    for (let page = 0; page < MAX_SCAN_PAGES; page++) {
      const result = await this.ddb.send(
        new ScanCommand({ TableName: this.tables[resource], ExclusiveStartKey: startKey, ...extra }),
      );
      items.push(...((result.Items ?? []) as Record<string, unknown>[]));
      startKey = result.LastEvaluatedKey;
      if (!startKey) break;
    }
    return items;
  }

  async list(resource: CatalogResource, claims: UserClaims, query: Record<string, string | undefined>) {
    callerUserId(claims);
    const extra: Record<string, unknown> = {};
    if (resource === 'pictures' && query.categoryId !== undefined) {
      extra.FilterExpression = '#categoryId = :categoryId';
      extra.ExpressionAttributeNames = { '#categoryId': 'categoryId' };
      extra.ExpressionAttributeValues = { ':categoryId': parseField('categoryId', 'number', query.categoryId) };
    }
    const items = await this.scanAll(resource, extra);
    return items.sort(
      (a, b) => Number(a.positionId ?? Number.MAX_SAFE_INTEGER) - Number(b.positionId ?? Number.MAX_SAFE_INTEGER),
    );
  }

  async get(resource: CatalogResource, claims: UserClaims, rawId: string) {
    callerUserId(claims);
    const result = await this.ddb.send(
      new GetCommand({ TableName: this.tables[resource], Key: { id: this.key(resource, rawId) } }),
    );
    if (!result.Item) throw new UserRequestError('Not found.', 404, 'NOT_FOUND');
    return result.Item;
  }

  async create(resource: CatalogResource, claims: UserClaims, body: Record<string, unknown>) {
    this.requireAdmin(claims);
    const spec = SPECS[resource];
    const fields = pickFields(spec, body);
    spec.required.forEach((name) => {
      if (fields[name] === undefined) throw invalid(`"${name}" is required.`);
    });

    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
      const existing = await this.scanAll(resource, { ProjectionExpression: 'id' });
      const nextId = existing.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
      const item = {
        ...spec.defaults,
        ...fields,
        id: spec.idType === 'number' ? nextId : String(nextId),
        userId: callerUserId(claims),
      };
      try {
        await this.ddb.send(
          new PutCommand({
            TableName: this.tables[resource],
            Item: item,
            ConditionExpression: 'attribute_not_exists(id)',
          }),
        );
        return item;
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
      }
    }
    throw new UserRequestError('Unable to allocate an id, retry.', 409, 'ID_CONFLICT');
  }

  async update(resource: CatalogResource, claims: UserClaims, rawId: string, body: Record<string, unknown>) {
    this.requireAdmin(claims);
    const fields = pickFields(SPECS[resource], body);
    const names = Object.keys(fields);
    if (!names.length) throw new UserRequestError('No updatable fields provided.', 400, 'NO_FIELDS');

    try {
      const result = await this.ddb.send(
        new UpdateCommand({
          TableName: this.tables[resource],
          Key: { id: this.key(resource, rawId) },
          UpdateExpression: 'SET ' + names.map((name) => `#${name} = :${name}`).join(', '),
          ConditionExpression: 'attribute_exists(id)',
          ExpressionAttributeNames: Object.fromEntries(names.map((name) => [`#${name}`, name])),
          ExpressionAttributeValues: Object.fromEntries(names.map((name) => [`:${name}`, fields[name]])),
          ReturnValues: 'ALL_NEW',
        }),
      );
      return result.Attributes;
    } catch (error) {
      if (isConditionalFailure(error)) throw new UserRequestError('Not found.', 404, 'NOT_FOUND');
      throw error;
    }
  }
}
