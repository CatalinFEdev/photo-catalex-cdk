import { getAuth } from '../lambda/shared/auth';

describe('getAuth', () => {
  const eventWith = (claims: Record<string, string>) => ({ requestContext: { authorizer: { claims } } });

  test('returns no user when claims are missing', () => {
    expect(getAuth({})).toEqual({ userId: undefined, groups: [], isAdmin: false });
  });

  test('reads sub as userId', () => {
    expect(getAuth(eventWith({ sub: 'u1' })).userId).toBe('u1');
  });

  test('detects admin from a space separated group list', () => {
    const auth = getAuth(eventWith({ sub: 'u1', 'cognito:groups': 'users admins' }));
    expect(auth.groups).toEqual(['users', 'admins']);
    expect(auth.isAdmin).toBe(true);
  });

  test('detects admin from a bracketed, comma separated list', () => {
    expect(getAuth(eventWith({ sub: 'u1', 'cognito:groups': '[admins, other]' })).isAdmin).toBe(true);
  });

  test('does not treat similar group names as admin', () => {
    expect(getAuth(eventWith({ sub: 'u1', 'cognito:groups': 'superadmins' })).isAdmin).toBe(false);
  });
});
