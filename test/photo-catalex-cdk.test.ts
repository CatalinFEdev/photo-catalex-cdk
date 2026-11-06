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
    test('creates exactly three tables', () => {
      template.resourceCountIs('AWS::DynamoDB::Table', 3);
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
    test('creates the API functions and the image processor', () => {
      template.resourceCountIs('AWS::Lambda::Function', 4);
    });

    test('function is configured with tables and avatar bucket', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs24.x',
        Architectures: ['arm64'],
        MemorySize: 256,
        Timeout: 10,
        Handler: 'index.handler',
        Environment: {
          Variables: {
            USERS_TABLE_NAME: { Ref: Match.stringLikeRegexp('PhotoUsers') },
            USER_PROFILES_TABLE_NAME: { Ref: Match.stringLikeRegexp('PhotoUserProfiles') },
            AVATAR_BUCKET: 'photo-ca-user-profiles',
          },
        },
      });
    });

    test('log group retains logs for one month', () => {
      template.resourceCountIs('AWS::Logs::LogGroup', 4);
      template.allResourcesProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
    });

    test('function can read and write the tables but not delete', () => {
      const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
      ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query', 'dynamodb:Scan'].forEach((a) =>
        expect(policies).toContain(a),
      );
      expect(policies).not.toContain('dynamodb:DeleteItem');
    });

    test('catalog function is wired to the app1 and app2 tables', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            CATEGORIES_TABLE_NAME: 'photo-categories',
            PICTURES_TABLE_NAME: 'photo-pictures',
            ART_CATEGORIES_TABLE_NAME: 'categories',
            ART_PICTURES_TABLE_NAME: 'pictures',
          }),
        },
      });
      const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
      ['table/photo-categories', 'table/photo-pictures', 'table/categories', 'table/pictures'].forEach((t) =>
        expect(policies).toContain(t),
      );
    });

    test('avatar access is limited to the avatars/ prefix', () => {
      const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
      expect(policies).toContain('photo-ca-user-profiles/avatars/*');
      expect(policies).not.toContain('s3:DeleteObject');
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

    test('resource paths match the Angular app contract', () => {
      ['user', 'users', 'profile', 'avatar', '{userId}'].forEach((p) => {
        template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: p });
      });
      // user, user/profile, user/avatar, users, users/{userId}, + profile and avatar
      template.resourceCountIs('AWS::ApiGateway::Resource', 17);
    });

    test('all non-OPTIONS methods are secured with Cognito and use Lambda proxy', () => {
      const methods = Object.values(template.findResources('AWS::ApiGateway::Method')).filter(
        (m) => m.Properties.HttpMethod !== 'OPTIONS',
      );
      // users: user(4) profile(3) avatar(1) users(2) userId(4) profile(3) avatar(1);       catalog: 4 x (collection 3 + item 3); originals: collection 2 + item 1
      expect(methods).toHaveLength(45);
      methods.forEach((m) => {
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
                'method.response.header.Access-Control-Allow-Methods': "'GET,POST,PUT,PATCH,OPTIONS'",
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

  describe('Originals pipeline', () => {
    test('photo-originals table keyed by id and retained', () => {
      template.hasResource('AWS::DynamoDB::Table', {
        Properties: Match.objectLike({
          TableName: 'photo-originals',
          KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
        }),
        DeletionPolicy: 'Retain',
      });
    });

    test('no bucket is created (existing buckets are referenced)', () => {
      template.resourceCountIs('AWS::S3::Bucket', 0);
    });

    test('new originals trigger the processor through EventBridge', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: {
          source: ['aws.s3'],
          'detail-type': ['Object Created'],
          detail: { bucket: { name: ['photo-pictures-originals'] } },
        },
      });
    });

    test('processor is sized for large images and writes to photo-pictures', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        MemorySize: 2048,
        Timeout: 300,
        Environment: { Variables: Match.objectLike({ PICTURES_BUCKET: 'photo-pictures' }) },
      });
      const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
      expect(policies).toContain(':s3:::photo-pictures/*');
    });
  });

  describe('Outputs', () => {
    test.each(['UsersApiFnName', 'CatalogApiFnName', 'OriginalsApiFnName', 'ApiUrl'])('exports %s', (name) => {
      template.hasOutput(name, {});
    });
  });
});
