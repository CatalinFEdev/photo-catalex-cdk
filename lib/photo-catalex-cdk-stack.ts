import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { PhotoLambdaFunction } from './constructs/photo-lambda-function';

export interface PhotoCatalexCdkStackProps extends cdk.StackProps {
  userPoolId: string;
  /** Existing S3 bucket for avatars (objects under vatars/). */
  avatarBucketName?: string;
  /** Optional CloudFront domain serving avatars; presigned URLs are used when empty. */
  avatarCdnDomain?: string;
}

export class PhotoCatalexCdkStack extends cdk.Stack {
  public readonly userPool: cognito.IUserPool;
  public readonly categoriesTable: dynamodb.ITable;
  public readonly picturesTable: dynamodb.ITable;
  public readonly usersTable: dynamodb.Table;
  public readonly userProfilesTable: dynamodb.Table;
  public readonly avatarBucket: s3.IBucket;
  public readonly usersApiFn: nodejs.NodejsFunction;
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: PhotoCatalexCdkStackProps) {
    super(scope, id, props);

    this.userPool = cognito.UserPool.fromUserPoolId(this, 'ExistingUserPool', props.userPoolId);

    this.categoriesTable = dynamodb.Table.fromTableName(this, 'PhotoCategories', 'photo-categories');
    this.picturesTable = dynamodb.Table.fromTableName(this, 'PhotoPictures', 'photo-pictures');

    this.usersTable = new dynamodb.Table(this, 'PhotoUsers', {
      tableName: 'photo-users',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.usersTable.addGlobalSecondaryIndex({
      indexName: 'username-index',
      partitionKey: { name: 'username', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.userProfilesTable = new dynamodb.Table(this, 'PhotoUserProfiles', {
      tableName: 'photo-user-profiles',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.avatarBucket = s3.Bucket.fromBucketName(this, 'AvatarBucket', props.avatarBucketName ?? 'photo-ca-user-profiles');

    this.usersApiFn = new PhotoLambdaFunction(this, 'UsersApiFn', {
      fileName: 'users-api',
      environment: {
        USERS_TABLE_NAME: this.usersTable.tableName,
        USER_PROFILES_TABLE_NAME: this.userProfilesTable.tableName,
        AVATAR_BUCKET: this.avatarBucket.bucketName,
        ...(props.avatarCdnDomain ? { AVATAR_CDN_DOMAIN: props.avatarCdnDomain } : {}),
      },
    });
    // Least privilege: no DeleteItem, and only the avatars/ prefix in S3
    this.usersTable.grant(this.usersApiFn, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query', 'dynamodb:Scan');
    this.userProfilesTable.grant(this.usersApiFn, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem');
    this.usersApiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: [this.avatarBucket.arnForObjects('avatars/*')],
      }),
    );

    this.api = new apigateway.RestApi(this, 'PhotoApi', {
      restApiName: 'photo-catalex-api',
      deployOptions: {
        stageName: 'prod',
        throttlingRateLimit: 20,
        throttlingBurstLimit: 40,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: ['http://localhost:4200', 'https://photo.catalinalexandru.at'],
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type'],
      },
    });

    this.api.addGatewayResponse('Default4xx', {
      type: apigateway.ResponseType.DEFAULT_4XX,
      responseHeaders: { 'Access-Control-Allow-Origin': "'https://photo.catalinalexandru.at'" },
    });
    this.api.addGatewayResponse('Default5xx', {
      type: apigateway.ResponseType.DEFAULT_5XX,
      responseHeaders: { 'Access-Control-Allow-Origin': "'https://photo.catalinalexandru.at'" },
    });

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'PhotoAuthorizer', {
      cognitoUserPools: [this.userPool],
    });

    const secured: apigateway.MethodOptions = {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer,
    };

    const usersApi = new apigateway.LambdaIntegration(this.usersApiFn);
    const addMethods = (resource: apigateway.IResource, methods: string[]) =>
      methods.forEach((method) => resource.addMethod(method, usersApi, secured));

    // Same contract as the Angular app: /user (self) and /users/{userId} (admin or owner)
    const user = this.api.root.addResource('user');
    addMethods(user, ['GET', 'POST', 'PUT', 'PATCH']);
    addMethods(user.addResource('profile'), ['POST', 'PUT', 'PATCH']);
    addMethods(user.addResource('avatar'), ['POST']);

    const users = this.api.root.addResource('users');
    addMethods(users, ['GET', 'POST']);
    const userById = users.addResource('{userId}');
    addMethods(userById, ['GET', 'POST', 'PUT', 'PATCH']);
    addMethods(userById.addResource('profile'), ['POST', 'PUT', 'PATCH']);
    addMethods(userById.addResource('avatar'), ['POST']);

    new cdk.CfnOutput(this, 'UsersApiFnName', { value: this.usersApiFn.functionName });
    new cdk.CfnOutput(this, 'ApiUrl', { value: this.api.url });
  }
}
