import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
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
  public readonly artCategoriesTable: dynamodb.ITable;
  public readonly artPicturesTable: dynamodb.ITable;
  public readonly usersTable: dynamodb.Table;
  public readonly userProfilesTable: dynamodb.Table;
  public readonly avatarBucket: s3.IBucket;
  public readonly usersApiFn: nodejs.NodejsFunction;
  public readonly catalogApiFn: nodejs.NodejsFunction;
  public readonly originalsTable: dynamodb.Table;
  public readonly originalsBucket: s3.IBucket;
  public readonly picturesBucket: s3.IBucket;
  public readonly originalsApiFn: nodejs.NodejsFunction;
  public readonly processOriginalFn: nodejs.NodejsFunction;
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: PhotoCatalexCdkStackProps) {
    super(scope, id, props);

    this.userPool = cognito.UserPool.fromUserPoolId(this, 'ExistingUserPool', props.userPoolId);

    this.categoriesTable = dynamodb.Table.fromTableName(this, 'PhotoCategories', 'photo-categories');
    this.picturesTable = dynamodb.Table.fromTableName(this, 'PhotoPictures', 'photo-pictures');
    this.artCategoriesTable = dynamodb.Table.fromTableName(this, 'ArtCategories', 'categories');
    this.artPicturesTable = dynamodb.Table.fromTableName(this, 'ArtPictures', 'pictures');

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

    this.catalogApiFn = new PhotoLambdaFunction(this, 'CatalogApiFn', {
      fileName: 'catalog-api',
      environment: {
        CATEGORIES_TABLE_NAME: this.categoriesTable.tableName,
        PICTURES_TABLE_NAME: this.picturesTable.tableName,
        ART_CATEGORIES_TABLE_NAME: this.artCategoriesTable.tableName,
        ART_PICTURES_TABLE_NAME: this.artPicturesTable.tableName,
      },
    });
    const catalogActions = ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Scan'];
    this.categoriesTable.grant(this.catalogApiFn, ...catalogActions);
    this.picturesTable.grant(this.catalogApiFn, ...catalogActions);
    this.artCategoriesTable.grant(this.catalogApiFn, ...catalogActions);
    this.artPicturesTable.grant(this.catalogApiFn, ...catalogActions);

    this.originalsTable = new dynamodb.Table(this, 'PhotoOriginals', {
      tableName: 'photo-originals',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Existing bucket (CORS already allows browser PUTs). No size limit: browsers upload with presigned PUT URLs
    this.originalsBucket = s3.Bucket.fromBucketName(this, 'OriginalsBucket', 'photo-pictures-originals');
    this.picturesBucket = s3.Bucket.fromBucketName(this, 'PicturesBucket', 'photo-pictures');

    this.originalsApiFn = new PhotoLambdaFunction(this, 'OriginalsApiFn', {
      fileName: 'originals-api',
      environment: {
        ORIGINALS_TABLE_NAME: this.originalsTable.tableName,
        ORIGINALS_BUCKET: this.originalsBucket.bucketName,
      },
    });
    this.originalsTable.grant(this.originalsApiFn, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Scan');
    this.originalsBucket.grantPut(this.originalsApiFn);

    // Creates the <=1000px copy in photo-pictures and stores the EXIF data
    this.processOriginalFn = new PhotoLambdaFunction(this, 'ProcessOriginalFn', {
      fileName: 'process-original',
      memorySize: 2048,
      timeout: cdk.Duration.minutes(5),
      withSharp: true,
      environment: {
        ORIGINALS_TABLE_NAME: this.originalsTable.tableName,
        PICTURES_BUCKET: this.picturesBucket.bucketName,
      },
    });
    this.originalsTable.grant(this.processOriginalFn, 'dynamodb:UpdateItem');
    this.originalsBucket.grantRead(this.processOriginalFn);
    this.processOriginalFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [this.picturesBucket.arnForObjects('*')] }),
    );
    // The bucket already notifies photo-ca-admin-api and S3 rejects overlapping notifications,
    // so the processor is triggered through EventBridge (must be enabled on the bucket, see README)
    new events.Rule(this, 'OriginalUploadedRule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: { bucket: { name: [this.originalsBucket.bucketName] } },
      },
      targets: [new targets.LambdaFunction(this.processOriginalFn, { retryAttempts: 2 })],
    });

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

    // Reads for any signed-in user; writes are restricted to the `admins` group in the Lambda
    // A single wildcard permission avoids per-route statements overflowing the 20KB Lambda policy limit
    const catalogApi = new apigateway.AwsIntegration({
      service: 'lambda',
      proxy: true,
      path: `2015-03-31/functions/${this.catalogApiFn.functionArn}/invocations`,
    });
    this.catalogApiFn.addPermission('ApiInvokeAllRoutes', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: this.api.arnForExecuteApi('*', '/*', '*'),
    });
    const addCatalogRoutes = (name: string) => {
      const collection = this.api.root.addResource(name);
      ['GET', 'POST', 'PUT'].forEach((method) => collection.addMethod(method, catalogApi, secured));
      const item = collection.addResource('{id}');
      ['GET', 'PUT', 'PATCH'].forEach((method) => item.addMethod(method, catalogApi, secured));
    };
    addCatalogRoutes('photo-categories');
    addCatalogRoutes('photo-pictures');
    addCatalogRoutes('categories');
    addCatalogRoutes('pictures');

    const originalsApi = new apigateway.LambdaIntegration(this.originalsApiFn);
    const originals = this.api.root.addResource('photo-originals');
    ['GET', 'POST'].forEach((method) => originals.addMethod(method, originalsApi, secured));
    originals.addResource('{id}').addMethod('GET', originalsApi, secured);

    new cdk.CfnOutput(this, 'OriginalsApiFnName', { value: this.originalsApiFn.functionName });
    new cdk.CfnOutput(this, 'CatalogApiFnName', { value: this.catalogApiFn.functionName });
    new cdk.CfnOutput(this, 'UsersApiFnName', { value: this.usersApiFn.functionName });
    new cdk.CfnOutput(this, 'ApiUrl', { value: this.api.url });
  }
}
