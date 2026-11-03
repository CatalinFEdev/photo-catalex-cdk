import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ApiEvent, getAuth } from './shared/auth';
import { response } from './shared/response';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const tableName = process.env.USERS_TABLE_NAME!;

export const handler = async (event: ApiEvent) => {
  const auth = getAuth(event);
  if (!auth.userId) {
    return response(401, { message: 'Unauthorized' });
  }

  const requestedUserId = event.pathParameters?.userId;
  if (requestedUserId && !auth.isAdmin) {
    return response(403, { message: 'Forbidden' });
  }

  const userId = requestedUserId ?? auth.userId;
  const result = await client.send(new GetCommand({ TableName: tableName, Key: { userId } }));
  if (!result.Item) {
    return response(404, { message: 'User not found' });
  }

  return response(200, result.Item);
};
