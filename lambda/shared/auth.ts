export interface ApiEvent {
  pathParameters?: Record<string, string | undefined>;
  requestContext?: { authorizer?: { claims?: Record<string, string> } };
}

const ADMIN_GROUP = 'admins';

export const getAuth = (event: ApiEvent) => {
  const claims = event.requestContext?.authorizer?.claims ?? {};
  const groups = (claims['cognito:groups'] ?? '')
    .replace(/[\[\]]/g, '')
    .split(/[,\s]+/)
    .filter(Boolean);

  return {
    userId: claims.sub as string | undefined,
    groups,
    isAdmin: groups.includes(ADMIN_GROUP),
  };
};
