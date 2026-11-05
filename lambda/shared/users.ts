import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

export const ADMIN_GROUP = 'admins';

const CORE_UPDATABLE_KEYS = [
  'firstName',
  'lastName',
  'phoneNumber',
  'preferredLanguage',
  'username',
  'accountType',
  'avatarUrl',
] as const;

const PROFILE_UPDATABLE_KEYS = [
  'bio',
  'website',
  'location',
  'instagram',
  'facebook',
  'linkedin',
  'twitter',
  'youtube',
  'pinterest',
  'behance',
  'flickr',
  'vimeo',
] as const;

const PROFILE_KEYS = new Set<string>([
  ...PROFILE_UPDATABLE_KEYS,
  'followersCount',
  'followingCount',
  'profileViews',
]);

const PRIVATE_KEYS = ['email', 'phoneNumber', 'emailVerified', 'cognitoSub', 'groups', 'banned'];

const AVATAR_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const AVATAR_UPLOAD_TTL_SECONDS = 900;
const AVATAR_VIEW_TTL_SECONDS = 3600;

export interface UserClaims {
  sub?: string;
  email?: string;
  email_verified?: unknown;
  given_name?: string;
  family_name?: string;
  picture?: string;
  phone_number?: string;
  'cognito:groups'?: unknown;
  'custom:accountType'?: string;
  identities?: unknown;
  [key: string]: unknown;
}

export type UserRecord = Record<string, unknown> & { userId: string };

export class UserRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = 'INVALID_REQUEST',
  ) {
    super(message);
    this.name = 'UserRequestError';
  }
}

export interface UsersConfig {
  usersTable: string;
  profilesTable: string;
  avatarBucket: string;
  avatarCdnDomain?: string;
}

export const callerUserId = (claims: UserClaims): string => {
  const sub = typeof claims.sub === 'string' ? claims.sub.trim() : '';
  if (!sub) throw new UserRequestError('Unauthorized.', 401, 'UNAUTHENTICATED');
  return sub;
};

export const callerGroups = (claims: UserClaims): string[] => {
  const raw = claims['cognito:groups'];
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((g) => String(g).trim()).filter(Boolean);
  return String(raw)
    .replace(/[\[\]]/g, '')
    .split(/[,\s]+/)
    .filter(Boolean);
};

export const isAdmin = (claims: UserClaims): boolean => callerGroups(claims).includes(ADMIN_GROUP);

const requireAdmin = (claims: UserClaims) => {
  callerUserId(claims);
  if (!isAdmin(claims)) throw new UserRequestError('Forbidden.', 403, 'FORBIDDEN');
};

const requireSelfOrAdmin = (claims: UserClaims, targetUserId: string) => {
  if (callerUserId(claims) !== targetUserId && !isAdmin(claims)) {
    throw new UserRequestError('Forbidden.', 403, 'FORBIDDEN');
  }
};

export type UserRoute =
  | { kind: 'self' | 'selfProfile' | 'selfAvatar' | 'collection' }
  | { kind: 'item' | 'itemProfile' | 'itemAvatar'; userId: string };

export const matchUserRoute = (path: string): UserRoute | null => {
  const clean = path.replace(/\/+$/, '') || '/';

  if (clean === '/user') return { kind: 'self' };
  if (clean === '/user/profile') return { kind: 'selfProfile' };
  if (clean === '/user/avatar') return { kind: 'selfAvatar' };
  if (clean === '/users') return { kind: 'collection' };

  const match = /^\/users\/([^/]+)(?:\/([^/]+))?$/.exec(clean);
  if (!match) return null;

  const userId = decodeURIComponent(match[1]);
  switch (match[2]) {
    case undefined:
      return { kind: 'item', userId };
    case 'profile':
      return { kind: 'itemProfile', userId };
    case 'avatar':
      return { kind: 'itemAvatar', userId };
    default:
      return null;
  }
};

const deriveUsername = (email: string) =>
  (email.split('@')[0] ?? '').toLowerCase().replace(/[^a-z0-9_.-]/g, '');

const detectProvider = (claims: UserClaims): string => {
  try {
    const raw = claims.identities;
    if (!raw) return 'cognito';
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const name = (Array.isArray(parsed) ? parsed[0] : parsed)?.providerName;
    return typeof name === 'string' && name ? name.toLowerCase() : 'cognito';
  } catch {
    return 'cognito';
  }
};

const toPublicUser = (user: UserRecord): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...user };
  PRIVATE_KEYS.forEach((key) => delete copy[key]);
  return copy;
};

const isConditionalFailure = (error: unknown) =>
  (error as { name?: string })?.name === 'ConditionalCheckFailedException';

const buildUpdate = (
  body: Record<string, unknown>,
  allowedKeys: readonly string[],
  tableName: string,
  userId: string,
  extra: Record<string, unknown> = {},
) => {
  const fields: [string, unknown][] = [
    ...allowedKeys.filter((name) => name in body).map((name): [string, unknown] => [name, body[name]]),
    ...Object.entries(extra),
  ];
  if (!fields.length || fields.length === Object.keys(extra).length) {
    throw new UserRequestError('No updatable fields provided.', 400, 'NO_FIELDS');
  }

  return {
    TableName: tableName,
    Key: { userId },
    UpdateExpression: 'SET ' + fields.map(([name]) => `#${name} = :${name}`).join(', '),
    ExpressionAttributeNames: Object.fromEntries(fields.map(([name]) => [`#${name}`, name])),
    ExpressionAttributeValues: Object.fromEntries(fields.map(([name, value]) => [`:${name}`, value])),
    ReturnValues: 'ALL_NEW' as const,
  };
};

export class UserService {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly s3: S3Client,
    private readonly config: UsersConfig,
  ) {}

  async getUser(targetUserId: string, claims: UserClaims): Promise<Record<string, unknown>> {
    const { usersTable, profilesTable } = this.config;
    let core = (await this.ddb.send(new GetCommand({ TableName: usersTable, Key: { userId: targetUserId } }))).Item;
    let profile = (
      await this.ddb
        .send(new GetCommand({ TableName: profilesTable, Key: { userId: targetUserId } }))
        .catch(() => ({ Item: undefined }))
    ).Item;

    if (!core) {
      // Only the owner can provision their own record on first access
      if (claims.sub !== targetUserId) throw new UserRequestError('User not found.', 404, 'USER_NOT_FOUND');
      core = await this.provisionUser(targetUserId, claims);
      profile = undefined;
    }

    const extensions = Object.fromEntries(Object.entries(profile ?? {}).filter(([key]) => PROFILE_KEYS.has(key)));
    const user = { ...core, ...extensions } as UserRecord;
    user.avatarUrl = await this.resolveAvatarUrl(user.avatarUrl);

    return claims.sub === user.userId || isAdmin(claims) ? user : toPublicUser(user);
  }

  async createUser(claims: UserClaims, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const userId = callerUserId(claims);
    if (!(typeof body.email === 'string' && body.email) && !claims.email) {
      throw new UserRequestError('email is required.', 400, 'MISSING_EMAIL');
    }

    const existing = await this.ddb.send(
      new GetCommand({ TableName: this.config.usersTable, Key: { userId } }),
    );
    if (existing.Item) throw new UserRequestError('User already exists.', 409, 'USER_EXISTS');

    return this.provisionUser(userId, claims, body);
  }

  private async provisionUser(
    userId: string,
    claims: UserClaims,
    body: Record<string, unknown> = {},
  ): Promise<UserRecord> {
    const now = new Date().toISOString();
    const email = String((typeof body.email === 'string' && body.email) || claims.email || '').toLowerCase();
    const firstName = String(body.firstName ?? claims.given_name ?? '');
    const lastName = String(body.lastName ?? claims.family_name ?? '');
    const username = String(body.username ?? (email ? deriveUsername(email) : userId)).toLowerCase();

    const item: UserRecord = {
      userId,
      email,
      emailVerified: body.emailVerified ?? (claims.email_verified === true || claims.email_verified === 'true'),
      cognitoSub: userId,
      provider: body.provider ?? detectProvider(claims),
      username,
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`.trim() || username,
      avatarUrl: (body.avatarUrl as string | undefined) ?? claims.picture ?? '',
      phoneNumber: (body.phoneNumber as string | undefined) ?? claims.phone_number ?? '',
      preferredLanguage: body.preferredLanguage ?? 'en',
      accountType: body.accountType ?? claims['custom:accountType'] ?? 'hobbyist',
      tier: 'free',
      followersCount: 0,
      followingCount: 0,
      photosCount: 0,
      totalSales: 0,
      profileViews: 0,
      groups: callerGroups(claims),
      banned: false,
      createdAt: now,
      updatedAt: now,
    };

    const putIfAbsent = (TableName: string, Item: Record<string, unknown>) =>
      this.ddb
        .send(new PutCommand({ TableName, Item, ConditionExpression: 'attribute_not_exists(userId)' }))
        .catch((error: unknown) => {
          if (!isConditionalFailure(error)) throw error;
        });

    await Promise.all([
      putIfAbsent(this.config.usersTable, item),
      putIfAbsent(this.config.profilesTable, { userId, createdAt: now, updatedAt: now }),
    ]);

    return item;
  }

  async updateUserData(
    targetUserId: string,
    claims: UserClaims,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    requireSelfOrAdmin(claims, targetUserId);

    const extra: Record<string, unknown> = { updatedAt: new Date().toISOString() };

    if ('firstName' in body || 'lastName' in body) {
      const current = (
        await this.ddb.send(new GetCommand({ TableName: this.config.usersTable, Key: { userId: targetUserId } }))
      ).Item;
      const firstName = body.firstName ?? current?.firstName ?? '';
      const lastName = body.lastName ?? current?.lastName ?? '';
      extra.fullName = `${String(firstName)} ${String(lastName)}`.trim();
    }

    const normalized = typeof body.username === 'string' ? { ...body, username: body.username.toLowerCase() } : body;
    const params = {
      ...buildUpdate(normalized, CORE_UPDATABLE_KEYS, this.config.usersTable, targetUserId, extra),
      ConditionExpression: 'attribute_exists(userId)',
    };

    try {
      const attributes = ((await this.ddb.send(new UpdateCommand(params))).Attributes ?? {}) as Record<string, unknown>;
      if ('avatarUrl' in attributes) attributes.avatarUrl = await this.resolveAvatarUrl(attributes.avatarUrl);
      return attributes;
    } catch (error) {
      if (isConditionalFailure(error)) throw new UserRequestError('User not found.', 404, 'USER_NOT_FOUND');
      throw error;
    }
  }

  async updateSocialProfile(
    targetUserId: string,
    claims: UserClaims,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    requireSelfOrAdmin(claims, targetUserId);

    const params = buildUpdate(body, PROFILE_UPDATABLE_KEYS, this.config.profilesTable, targetUserId, {
      updatedAt: new Date().toISOString(),
    });
    return ((await this.ddb.send(new UpdateCommand(params))).Attributes ?? {}) as Record<string, unknown>;
  }

  async getAvatarUploadUrl(
    targetUserId: string,
    claims: UserClaims,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    requireSelfOrAdmin(claims, targetUserId);

    const contentType = String(body.contentType ?? 'image/jpeg');
    const extension = AVATAR_EXTENSIONS[contentType];
    if (!extension) {
      throw new UserRequestError(`Unsupported content type: ${contentType}`, 400, 'INVALID_CONTENT_TYPE');
    }

    const fileName = `${targetUserId}-${Date.now()}.${extension}`;
    const key = `avatars/${fileName}`;
    const uploadUrl = await getSignedUrl(
      this.s3,
      new PutObjectCommand({ Bucket: this.config.avatarBucket, Key: key, ContentType: contentType }),
      { expiresIn: AVATAR_UPLOAD_TTL_SECONDS },
    );

    return { uploadUrl, key, avatarUrl: fileName, cdnUrl: fileName };
  }

  async getUserByUsername(username: string): Promise<Record<string, unknown>> {
    const result = await this.ddb.send(
      new QueryCommand({
        TableName: this.config.usersTable,
        IndexName: 'username-index',
        KeyConditionExpression: 'username = :username',
        ExpressionAttributeValues: { ':username': username.toLowerCase() },
        Limit: 1,
      }),
    );

    const user = result.Items?.[0] as UserRecord | undefined;
    if (!user) throw new UserRequestError('User not found.', 404, 'USER_NOT_FOUND');

    user.avatarUrl = await this.resolveAvatarUrl(user.avatarUrl);
    return toPublicUser(user);
  }

  async listUsers(claims: UserClaims, limit: number): Promise<Record<string, unknown>[]> {
    requireAdmin(claims);

    const result = await this.ddb.send(
      new ScanCommand({
        TableName: this.config.usersTable,
        Limit: Math.min(Math.max(Number.isFinite(limit) ? limit : 100, 1), 200),
        ProjectionExpression:
          'userId, email, firstName, lastName, fullName, username, accountType, tier, createdAt, banned',
      }),
    );
    return (result.Items ?? []) as Record<string, unknown>[];
  }

  // Avatars are stored as bare filenames and expanded on read
  private async resolveAvatarUrl(value: unknown): Promise<string> {
    const fileName = typeof value === 'string' ? value.trim() : '';
    if (!fileName || fileName.startsWith('http')) return fileName;

    const { avatarCdnDomain, avatarBucket } = this.config;
    if (avatarCdnDomain) return `https://${avatarCdnDomain}/avatars/${fileName}`;

    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: avatarBucket, Key: `avatars/${fileName}` }), {
      expiresIn: AVATAR_VIEW_TTL_SECONDS,
    }).catch(() => fileName);
  }
}
