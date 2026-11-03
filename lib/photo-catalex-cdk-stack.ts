import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { PhotoLambdaFunction } from './constructs/photo-lambda-function';

export interface PhotoCatalexCdkStackProps extends cdk.StackProps {
  userPoolId: string;
}

export class PhotoCatalexCdkStack extends cdk.Stack {
  public readonly userPool: cognito.IUserPool;
  public readonly categoriesTable: dynamodb.ITable;
  public readonly picturesTable: dynamodb.ITable;
  public readonly usersTable: dynamodb.Table;
  public readonly userProfilesTable: dynamodb.Table;
  public readonly getUserFn: nodejs.NodejsFunction;
  public readonly getUserProfileFn: nodejs.NodejsFunction;
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

    this.getUserFn = new PhotoLambdaFunction(this, 'GetUserFn', {
      fileName: 'get-user',
      environment: { USERS_TABLE_NAME: this.usersTable.tableName },
    });
    this.usersTable.grantReadData(this.getUserFn);

    this.getUserProfileFn = new PhotoLambdaFunction(this, 'GetUserProfileFn', {
      fileName: 'get-user-profile',
      environment: { USER_PROFILES_TABLE_NAME: this.userProfilesTable.tableName },
    });
    this.userProfilesTable.grantReadData(this.getUserProfileFn);

    this.api = new apigateway.RestApi(this, 'PhotoApi', {
      restApiName: 'photo-catalex-api',
      deployOptions: {
        stageName: 'prod',
        throttlingRateLimit: 20,
        throttlingBurstLimit: 40,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: ['http://localhost:4200', 'https://photo.catalinalexandru.at'],
        allowMethods: ['GET', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type'],
      },
    });

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'PhotoAuthorizer', {
      cognitoUserPools: [this.userPool],
    });

    const secured: apigateway.MethodOptions = {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer,
    };

    const getUserIntegration = new apigateway.LambdaIntegration(this.getUserFn);
    const getUserProfileIntegration = new apigateway.LambdaIntegration(this.getUserProfileFn);

    const me = this.api.root.addResource('users').addResource('me');
    me.addMethod('GET', getUserIntegration, secured);
    me.addResource('profile').addMethod('GET', getUserProfileIntegration, secured);

    const adminUser = this.api.root.addResource('admin').addResource('users').addResource('{userId}');
    adminUser.addMethod('GET', getUserIntegration, secured);
    adminUser.addResource('profile').addMethod('GET', getUserProfileIntegration, secured);

    new cdk.CfnOutput(this, 'GetUserFnName', { value: this.getUserFn.functionName });
    new cdk.CfnOutput(this, 'GetUserProfileFnName', { value: this.getUserProfileFn.functionName });
    new cdk.CfnOutput(this, 'ApiUrl', { value: this.api.url });
  }
}
