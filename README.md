# Project photo-catalex-cdk

Infrastructure as code for a photo platform, written in TypeScript with AWS CDK.
The stack is built incrementally: data layer first, then compute, authentication, API and CDN.

## Architecture

See [doc/architecture.md](doc/architecture.md) for the current state, the target state and the deployment flow.

## Resources

| Resource       | Name                             | Managed by CDK     | Status        | Notes                                                                                                                          |
|----------------|----------------------------------|--------------------|---------------|--------------------------------------------------------------------------------------------------------------------------------|
| DynamoDB       | `photo-categories`               | No (referenced)    | Existing      | No GSIs                                                                                                                        |
| DynamoDB       | `photo-pictures`                 | No (referenced)    | Existing      | No GSIs. Photos of the sell-photos app (app2)                                                                                  |
| DynamoDB       | `categories`, `pictures`         | No (referenced)    | Existing      | No GSIs. Art photo app (app1): categories and photos                                                                           |
| DynamoDB       | `photo-users`                    | Yes                | Deployed      | PK `userId`, GSI `username-index`, on-demand, retained                                                                         |
| DynamoDB       | `photo-user-profiles`            | Yes                | Deployed      | PK `userId`, on-demand, retained                                                                                               |
| Cognito        | Existing User Pool               | No (referenced)    | Referenced    | Referenced with `fromUserPoolId`; ID kept in git-ignored config                                                                |
| API Gateway    | REST API `photo-catalex-api`     | Yes                | Deployed      | Stage `prod`, throttling, CORS, Cognito authorizer on every route                                                              |
| Lambda         | `UsersApiFn`                     | Yes                | Defined       | Single handler for the `/user` and `/users` routes (same contract as the Angular app)                                          |
| Lambda         | `CatalogApiFn`                   | Yes                | Defined       | `/photo-categories`, `/photo-pictures` (app2) and `/categories`, `/pictures` (app1) routes (admin writes, authenticated reads) |
| S3             | `photo-ca-user-profiles`         | No (referenced)    | Existing      | Avatars under `avatars/` (presigned upload/read)                                                                               |
| DynamoDB       | `photo-originals`                | Yes                | Defined       | PK `id`, on-demand, retained. Upload status, file info and EXIF data                                                           |
| S3             | `photo-pictures-originals`       | No (referenced)    | Existing      | Originals, no size limit. Key `<id>/<fileName>`; CORS already allows PUT                                                       |
| S3             | `photo-pictures`                 | No (referenced)    | Existing      | Website copies (long side max 1000px, JPEG), key `<id>/0.jpg`                                                                  |
| Lambda         | `OriginalsApiFn`                 | Yes                | Defined       | `/photo-originals` routes (presigned upload URL, list, get)                                                                    |
| Lambda         | `ProcessOriginalFn`              | Yes                | Defined       | EventBridge trigger: resize with `sharp`, write to `photo-pictures`, store EXIF (2 GB, 5 min)                                  |

Planned, not yet in the stack: CloudFront.

## API routes

All routes require a valid Cognito ID token (`Authorization` header).

| Route                                                                  | Who                                                                                                                                     |
|------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------|
| `GET/POST/PUT/PATCH /user`                                             | Authenticated user (own record, `userId` = token `sub`; created on first `GET`)                                                         |
| `POST/PUT/PATCH /user/profile`                                         | Authenticated user (own extended profile)                                                                                               |
| `POST /user/avatar`                                                    | Authenticated user (presigned S3 upload URL)                                                                                            |
| `GET /users`                                                           | `admins` (list) or any user with `?username=` (public projection)                                                                       |
| `GET/PUT/PATCH /users/{userId}` (+ `/profile`, `/avatar`)              | Owner or `admins`; others get the public projection on `GET`                                                                            |
| `GET /photo-categories`, `GET /photo-pictures` (`?categoryId=`)        | Any authenticated user (sorted by `positionId`)                                                                                         |
| `GET /photo-categories/{id}`, `GET /photo-pictures/{id}`               | Any authenticated user                                                                                                                  |
| `POST`, `PUT` (id in body) on the collections; `PUT/PATCH` on `/{id}`  | `admins` only. Ids are allocated server side (categories: Number key, pictures: String key)                                             |
| `POST /photo-originals`                                                | `admins`. Body `{ fileName, contentType }` returns `{ id, uploadUrl, ... }`; `PUT` the file to `uploadUrl` with the same `Content-Type` |
| `GET /photo-originals`, `GET /photo-originals/{id}`                    | Any authenticated user (`status`: `pending`, `processing`, `ready`, `failed`; `pictureKey`, `width`, `height`, `exif`)                  |

### One-time step before deploying

`photo-pictures-originals` already notifies `photo-ca-admin-api` and S3 rejects overlapping notifications, so the processor is triggered through EventBridge. Enable EventBridge on the bucket while keeping the existing Lambda notification: take the current `LambdaFunctionConfigurations` from `aws s3api get-bucket-notification-configuration --bucket photo-pictures-originals`, add `"EventBridgeConfiguration": {}` to that JSON and apply it with `aws s3api put-bucket-notification-configuration --bucket photo-pictures-originals --notification-configuration file://notification.json`.

### Upload flow

1. The app calls `POST /photo-originals`; a `pending` record is written to `photo-originals`.
2. The browser uploads the file directly to the `photo-pictures-originals` bucket with the presigned URL, so API Gateway/Lambda payload limits do not apply and the app enforces no size limit (S3 allows up to 5 GB per single `PUT`).
3. EventBridge (`Object Created`) triggers `ProcessOriginalFn`, which streams the file through `sharp`, writes a JPEG with the long side at most 1000px to `photo-pictures/<id>/0.jpg`, and updates the record with the dimensions, `pictureKey` and the EXIF data. The website serves this smaller copy.

Responses are wrapped as `{ "data": ... }` and errors as `{ "message", "code" }`, matching `UserProfileService` in the Angular app (`photo-catalinalexandru`).

## Permissions

| Function              | Access                                                                                                                                                    |
|-----------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------|
| `UsersApiFn`          | `photo-users`: Get/Put/Update/Query/Scan; `photo-user-profiles`: Get/Put/Update; S3 `photo-ca-user-profiles/avatars/*`: Get/Put. No delete anywhere.      |
| `CatalogApiFn`        | `photo-categories`, `photo-pictures`, `categories`, `pictures`: Get/Put/Update/Scan. No delete.                                                           |
| `OriginalsApiFn`      | `photo-originals`: Get/Put/Scan; S3 `photo-pictures-originals`: Put (presign). No delete.                                                                 |
| `ProcessOriginalFn`   | `photo-originals`: Update; S3 `photo-pictures-originals`: Get; S3 `photo-pictures`: Put. No delete.                                                       |

## Design decisions

- **On-demand billing** (`PAY_PER_REQUEST`): no capacity planning for a low, unpredictable load.
- **`RemovalPolicy.RETAIN`** on stateful resources, so deleting the stack never drops data.
- **Existing resources are referenced**, not recreated: tables with `fromTableName`, the Cognito User Pool with `fromUserPoolId`, so CDK never modifies or deletes them and users stay unchanged.
- **One Lambda for the user API**, mirroring the Angular app's contract, with least-privilege grants (no delete, S3 limited to `avatars/*`).
- **Node.js 24 on ARM64**, bundled from TypeScript with esbuild (`NodejsFunction`), 1-month log retention.
- **Authentication before exposure**: user data is exposed, so every API route has a Cognito authorizer from the start.
- **Two layers of access control**: the authorizer verifies the token; the Lambda decides what the caller may read. Members of the Cognito group `admins` can read and edit any user; every other authenticated user can only edit their own data and sees others' public fields (`userId` always comes from the token, never from the request body).
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
- [x] Lambda deployed (`UsersApiFn`)
- [x] Existing Cognito User Pool referenced in the stack
- [x] API Gateway with a Cognito authorizer deployed
- [ ] Angular app (`photo-catalinalexandru`) switched to the new API URL and tested end to end
- [ ] CloudFront in front of the API
