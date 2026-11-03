# Project photo-catalex-cdk

Infrastructure as code for a photo platform, written in TypeScript with AWS CDK.
The stack is built incrementally: data layer first, then compute, authentication, API and CDN.

## Architecture

See [doc/architecture.md](doc/architecture.md) for the current state, the target state and the deployment flow.

## Resources

| Resource    | Name                         | Managed by CDK  | Status     | Notes                                                             |
|-------------|------------------------------|-----------------|------------|-------------------------------------------------------------------|
| DynamoDB    | `photo-categories`           | No (referenced) | Existing   | No GSIs                                                           |
| DynamoDB    | `photo-pictures`             | No (referenced) | Existing   | No GSIs                                                           |
| DynamoDB    | `photo-users`                | Yes             | Deployed   | PK `userId`, GSI `username-index`, on-demand, retained            |
| DynamoDB    | `photo-user-profiles`        | Yes             | Deployed   | PK `userId`, on-demand, retained                                  |
| Cognito     | Existing User Pool           | No (referenced) | Referenced | Referenced with `fromUserPoolId`; ID kept in git-ignored config   |
| API Gateway | REST API `photo-catalex-api` | Yes             | Defined    | Stage `prod`, throttling, CORS, Cognito authorizer on every route |
| Lambda      | `GetUserFn`                  | Yes             | Deployed   | Reads `photo-users` by `userId` (read-only)                       |
| Lambda      | `GetUserProfileFn`           | Yes             | Deployed   | Reads `photo-user-profiles` by `userId` (read-only)               |

Planned, not yet in the stack: CloudFront.

## API routes

All routes require a valid Cognito ID token (`Authorization` header).

| Route                               | Lambda             | Who                                                              |
|-------------------------------------|--------------------|------------------------------------------------------------------|
| `GET /users/me`                     | `GetUserFn`        | Any authenticated user (own data, `userId` from the token `sub`) |
| `GET /users/me/profile`             | `GetUserProfileFn` | Any authenticated user (own profile)                             |
| `GET /admin/users/{userId}`         | `GetUserFn`        | Group `admins` only                                              |
| `GET /admin/users/{userId}/profile` | `GetUserProfileFn` | Group `admins` only                                              |

## Permissions

| Function           | Table                           | Access    |
|--------------------|---------------------------------|-----------|
| `GetUserFn`        | `photo-users` (and its indexes) | Read-only |
| `GetUserProfileFn` | `photo-user-profiles`           | Read-only |

Each function has its own IAM role and cannot see the other function's table.

## Design decisions

- **On-demand billing** (`PAY_PER_REQUEST`): no capacity planning for a low, unpredictable load.
- **`RemovalPolicy.RETAIN`** on stateful resources, so deleting the stack never drops data.
- **Existing resources are referenced**, not recreated: tables with `fromTableName`, the Cognito User Pool with `fromUserPoolId`, so CDK never modifies or deletes them and users stay unchanged.
- **One Lambda per action**, each with least-privilege access: `grantReadData` on exactly the table it reads.
- **Node.js 24 on ARM64**, bundled from TypeScript with esbuild (`NodejsFunction`), 1-month log retention.
- **Authentication before exposure**: the functions return a full item by `userId`, so every API route has a Cognito authorizer from the start.
- **Two layers of access control**: the authorizer verifies the token; the Lambda decides what the caller may read. Members of the Cognito group `admins` can read any user; every other authenticated user can only read their own data (`userId` always comes from the token, never from the request body).
- **Roles come from Cognito groups**, which can only be changed server-side, not from user-editable attributes.
- **No secrets in the repository**: sensitive values live in AWS Secrets Manager / SSM Parameter Store.

## Project structure

```
bin/photo-catalex-cdk.ts          CDK app entry point (account from profile, region eu-central-1)
lib/photo-catalex-cdk-stack.ts    Stack definition
lambda/                           Lambda handlers (one file per action)
lambda/shared/                    Shared helpers
config/                           example.json committed; dev.local.json git-ignored
doc/                              Architecture diagrams (architecture.md)
scripts/                          One-off scripts (git-ignored)
```

## Getting started

Prerequisites: Node.js (LTS), AWS CLI with configured credentials, AWS CDK CLI.

```bash
npm install
cdk bootstrap   # once per account/region
cdk synth       # generate CloudFormation
cdk diff        # preview changes
cdk deploy      # deploy
```

`cdk destroy` removes the stack but keeps the tables (`RETAIN`).

## Data migration

The data of the new tables was copied from the earlier `photo-ca-*` tables with a one-off script
(scan and conditional put, so existing items are never overwritten and the script can be re-run safely).
The script is not part of the repository.

## Configuration

- Account comes from the active AWS profile, region is `eu-central-1`.
- Local-only settings (such as `userPoolId`) go in `config/dev.local.json` (git-ignored); `config/example.json` shows the expected keys.
- Secrets are never committed.

## Roadmap

- [x] CDK project, bootstrap, DynamoDB tables
- [x] Data copied into the new tables
- [x] Lambda functions deployed (`GetUserFn`, `GetUserProfileFn`)
- [x] Existing Cognito User Pool referenced in the stack
- [ ] API Gateway with a Cognito authorizer deployed and tested
- [ ] CloudFront in front of the API
