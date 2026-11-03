import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { PhotoCatalexCdkStack } from '../lib/photo-catalex-cdk-stack';

describe('PhotoCatalexCdkStack', () => {
  let template: Template;

  beforeAll(() => {
    // Empty list skips esbuild bundling of the lambdas
    const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const stack = new PhotoCatalexCdkStack(app, 'TestStack', {
      env: { account: '123456789012', region: 'eu-central-1' },
      userPoolId: 'eu-central-1_TESTPOOL',
    });
    template = Template.fromStack(stack);
  });

  describe('DynamoDB', () => {
    test('creates exactly two tables', () => {
      template.resourceCountIs('AWS::DynamoDB::Table', 2);
    });

    test('photo-users table with username GSI', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'photo-users',
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
        GlobalSecondaryIndexes: [
          Match.objectLike({
            IndexName: 'username-index',
            KeySchema: [{ AttributeName: 'username', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
          }),
        ],
      });
    });

    test('photo-user-profiles table', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'photo-user-profiles',
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
      });
    });

    test('tables are retained on delete', () => {
      const tables = template.findResources('AWS::DynamoDB::Table');
      Object.values(tables).forEach((t) => {
        expect(t.DeletionPolicy).toBe('Retain');
        expect(t.UpdateReplacePolicy).toBe('Retain');
      });
    });
  });

  describe('Lambda', () => {
    test('creates the two API functions', () => {
      template.resourceCountIs('AWS::Lambda::Function', 2);
    });

    test.each([
      ['USERS_TABLE_NAME', 'PhotoUsers'],
      ['USER_PROFILES_TABLE_NAME', 'PhotoUserProfiles'],
    ])('function configured with %s', (envVar, tableId) => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs24.x',
        Architectures: ['arm64'],
        MemorySize: 256,
        Timeout: 10,
        Handler: 'index.handler',
        Environment: {
          Variables: {
            [envVar]: { Ref: Match.stringLikeRegexp(tableId) },
          },
        },
      });
    });

    test('log groups retain logs for one month', () => {
      template.resourceCountIs('AWS::Logs::LogGroup', 2);
      template.allResourcesProperties('AWS::Logs::LogGroup', {
        RetentionInDays: 30,
      });
    });

    test('functions only get read access to their table', () => {
      const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
      expect(policies).toContain('dynamodb:GetItem');
      expect(policies).not.toContain('dynamodb:PutItem');
      expect(policies).not.toContain('dynamodb:DeleteItem');
      expect(policies).not.toContain('dynamodb:UpdateItem');
    });
  });

  describe('API Gateway', () => {
    test('creates a REST API', () => {
      template.hasResourceProperties('AWS::ApiGateway::RestApi', {
        Name: 'photo-catalex-api',
      });
    });

    test('prod stage with throttling', () => {
      template.hasResourceProperties('AWS::ApiGateway::Stage', {
        StageName: 'prod',
        MethodSettings: [
          Match.objectLike({
            ThrottlingRateLimit: 20,
            ThrottlingBurstLimit: 40,
          }),
        ],
      });
    });

    test('Cognito authorizer uses the existing user pool', () => {
      template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
        Type: 'COGNITO_USER_POOLS',
        IdentitySource: 'method.request.header.Authorization',
      });
      expect(JSON.stringify(template.findResources('AWS::ApiGateway::Authorizer'))).toContain(
        'eu-central-1_TESTPOOL',
      );
    });

    test('resource paths exist', () => {
      ['users', 'me', 'profile', 'admin', '{userId}'].forEach((p) => {
        template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: p });
      });
      // users, me, profile (x2), admin, users, {userId}
      template.resourceCountIs('AWS::ApiGateway::Resource', 7);
    });

    test('all GET methods are secured with Cognito and use Lambda proxy', () => {
      const methods = template.findResources('AWS::ApiGateway::Method', {
        Properties: { HttpMethod: 'GET' },
      });
      expect(Object.keys(methods)).toHaveLength(4);
      Object.values(methods).forEach((m) => {
        expect(m.Properties.AuthorizationType).toBe('COGNITO_USER_POOLS');
        expect(m.Properties.AuthorizerId).toBeDefined();
        expect(m.Properties.Integration.Type).toBe('AWS_PROXY');
      });
    });

    test('CORS preflight OPTIONS methods are public', () => {
      template.hasResourceProperties('AWS::ApiGateway::Method', {
        HttpMethod: 'OPTIONS',
        AuthorizationType: 'NONE',
        Integration: Match.objectLike({
          IntegrationResponses: Match.arrayWith([
            Match.objectLike({
              ResponseParameters: Match.objectLike({
                'method.response.header.Access-Control-Allow-Headers': "'Authorization,Content-Type'",
                'method.response.header.Access-Control-Allow-Methods': "'GET,OPTIONS'",
              }),
            }),
          ]),
        }),
      });
    });

    test('Lambda invoke permissions are granted to API Gateway', () => {
      template.hasResourceProperties('AWS::Lambda::Permission', {
        Action: 'lambda:InvokeFunction',
        Principal: 'apigateway.amazonaws.com',
      });
    });
  });

  describe('Outputs', () => {
    test.each(['GetUserFnName', 'GetUserProfileFnName', 'ApiUrl'])('exports %s', (name) => {
      template.hasOutput(name, {});
    });
  });
});
