const ALLOWED_ORIGINS = ['http://localhost:4200', 'https://photo.catalinalexandru.at'];

export const originOf = (event: { headers?: Record<string, string | undefined> }) =>
  event.headers?.origin ?? event.headers?.Origin;

export const response = (statusCode: number, body: unknown, origin?: string) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    ...(origin && ALLOWED_ORIGINS.includes(origin)
      ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
      : {}),
  },
  body: JSON.stringify(body),
});
