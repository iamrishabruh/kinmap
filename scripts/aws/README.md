# `scripts/aws` — accounts, access and guardrails

Automation for the multi-account AWS setup behind Kinmap: who can reach which account, what may happen in those accounts at all, and getting the CDK toolkit installed in each of them.

Everything here is **idempotent** and every script takes **`--dry-run`**. Run the dry run first, every time. It prints the exact AWS CLI commands it would issue and changes nothing.

| File                          | What it does                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| `permission-sets.sh`          | Creates the IAM Identity Center permission sets and assigns them to groups and accounts.    |
| `service-control-policies.sh` | Creates and attaches the organization SCPs on the Production OU and the root.               |
| `bootstrap-accounts.sh`       | Runs `cdk bootstrap` in each member account and region, after proving the profile is right. |
| `lib/aws-common.sh`           | Shared constants, account resolution, the identity guard, dry-run plumbing. Sourced only.   |

`lib/aws-common.sh` sources `scripts/bootstrap/lib/common.sh`, so logging, prompts and manual-gate reporting look and behave exactly like `scripts/bootstrap/bootstrap.sh`.

---

## The shape of the organization

```
management account 000000000000          <- Organizations + Identity Center. No workloads.
│                                           SCPs never restrict this account.
├── OU NonProduction  ou-xxxx-xxxxxxxx
│     ├── kinmap-development
│     └── kinmap-staging
└── OU Production     ou-xxxx-xxxxxxxx
      └── kinmap-production
```

- Identity Center instance `arn:aws:sso:::instance/ssoins-xxxxxxxxxxxxxxxx`, identity store `d-xxxxxxxxxx`, **in `us-east-2`**. Identity Center is a regional service; every `sso-admin` and `identitystore` call must carry that region or it silently talks to the wrong endpoint.
- Workload regions: `us-east-1` (primary — CloudFront and its ACM certificate must live there) and `us-west-2` (disaster recovery). Nothing else is permitted in production.

Account ids are resolved at run time, in this order:

1. `KINMAP_ACCOUNT_ID_DEVELOPMENT` / `_STAGING` / `_PRODUCTION` — explicit override.
2. Organizations, looked up by account name `kinmap-<env>` — authoritative once the accounts exist.
3. `bootstrap.config.local.json` → `aws.accounts.<env>` — the fallback before the accounts are created. The scripts say out loud when they use it.

Any environment that resolves to the management account is a hard refusal. Workloads in the management account cannot be constrained by an SCP, so every guardrail here would be inert.

---

## Run order

**Before anything:** the three member accounts must exist in Organizations and sit in the OUs above, and you need an AWS profile for the management account (`kinmap-management` by default).

```bash
# 0. one-off: a profile that reaches the management account
aws configure sso --profile kinmap-management     # start URL https://d-xxxxxxxxxx.awsapps.com/start, region us-east-2
aws sso login --profile kinmap-management

# 1. human access first — without it nobody can reach the member accounts
./scripts/aws/permission-sets.sh --dry-run
./scripts/aws/permission-sets.sh

# 2. put people in the groups the permission sets are assigned to (see below)

# 3. one-off: a profile per member account, using the permission sets from step 1
aws configure sso --profile kinmap-development
aws configure sso --profile kinmap-staging
aws configure sso --profile kinmap-production

# 4. guardrails, before there is anything valuable to guard
./scripts/aws/service-control-policies.sh --dry-run
./scripts/aws/service-control-policies.sh

# 5. CDK toolkit in every account and region
./scripts/aws/bootstrap-accounts.sh --dry-run
./scripts/aws/bootstrap-accounts.sh

# 6. deploy
pnpm cdk:deploy
```

Steps 4 and 5 are order-independent in practice — the SCPs deliberately do not block anything `cdk bootstrap` needs — but attaching guardrails before the first deploy means production is never briefly unguarded.

---

## `permission-sets.sh`

Creates four permission sets and assigns three of them. Re-running is safe: every object is looked up before it is created, session durations are reset if they have drifted, and inline policies are compared before they are written.

### What each permission set means, in plain language

#### `KinmapAdmin` — 8-hour sessions, **non-production only**

Full `AdministratorAccess`, assigned to `kinmap-development` and `kinmap-staging`.

- **Can:** anything at all, in development and staging.
- **Cannot:** touch production. The script refuses to assign it there, and on every run it checks whether someone assigned it out-of-band and prints the exact `delete-account-assignment` command if so.

Eight hours because that is a working day and re-authenticating mid-debug protects nobody in an environment that holds test data.

#### `KinmapProdDeploy` — 1-hour sessions, production

The interesting one. This is the permission set a normal production deploy uses.

- **Can:** run CloudFormation; assume the `cdk-hnb659fds-*` bootstrap roles; push assets to the CDK asset bucket; create, update and delete Lambda functions, API Gateway, SNS, SQS, EventBridge, Step Functions, CloudWatch, X-Ray, Route53, CloudFront, ACM, Cognito and WAF; read and write the `/kinmap/*` and `/cdk-bootstrap/*` parameters; administer KMS keys (create, alias, rotate, set policy); create and administer **DynamoDB tables and their indexes** — `CreateTable`, `UpdateTable` (which is how a global secondary index is added or removed), `DeleteTable`, TTL, tags, streams, PITR settings.
- **Cannot:** read a single row of location data. `GetItem`, `BatchGetItem`, `Query`, `Scan`, `PartiQLSelect` and stream `GetRecords` are explicitly denied on `CurrentLocations`, `LocationHistory`, `SavedPlaces`, `GeofenceState` and `LiveSessions` — including their indexes, streams, exports and backups, in every region.
- **Cannot:** get the data out sideways. `ExportTableToPointInTime`, `RestoreTableFromBackup` and `RestoreTableToPointInTime` are denied on those same tables, because restoring a backup into a table with a different name is otherwise a complete bypass of the read deny.
- **Cannot:** `kms:Decrypt` or `kms:ReEncryptFrom` the coordinate key (`alias/kinmap-production-coordinates`). Coordinates are encrypted with that customer-managed key, so this deny holds wherever they end up, not just in DynamoDB.
- **Cannot:** read secret values (`secretsmanager:GetSecretValue`). Deployments reference secrets by name; they never need the contents.
- **Cannot:** manufacture a way around any of the above. Creating IAM users, access keys, login profiles, SAML/OIDC providers, or editing a role's trust policy is denied, and `sts:AssumeRole` is denied on every role except the CDK bootstrap roles. Without those, "create a role that can read the table and assume it" is not available.

**The reasoning:** this product stores where people are. Deploying the infrastructure and reading the rows are different privileges that only look similar because AWS historically bundled them into one blunt policy. The default path grants the first and not the second. Nobody rolling a Lambda at 3am needs to be able to answer "where was this child on Tuesday", and an identity that could is an identity that will eventually be asked to.

#### `KinmapReadOnly` — 4-hour sessions, all three accounts

`ReadOnlyAccess` with the same two denies layered on top.

- **Can:** describe and list everything — stacks, functions, alarms, metrics, logs, table configuration.
- **Cannot:** read location table items, or decrypt the coordinate key, in any of the three accounts.

Read-only still exposes names, family structure and device metadata, so it is not "harmless" and does not get an all-day session.

#### `KinmapProdBreakGlass` — 1-hour sessions, **not assigned**

`AdministratorAccess` on production, including the ability to read location data. It is created but deliberately left unassigned; the script prints the exact `create-account-assignment` command to grant it and the matching `delete-account-assignment` to revoke it.

The name is the control. Every API call made through it appears in CloudTrail under the role `AWSReservedSSO_KinmapProdBreakGlass_*`, so "did anyone use god-mode last night?" is one CloudTrail query, not an investigation.

Rules of use: grant it for a specific incident, revoke it the same day, and write down why.

### Groups, not people

Permission sets are assigned to identity store groups, never to individual users:

| Group                 | Gets                                       |
| --------------------- | ------------------------------------------ |
| `KinmapAdmins`        | `KinmapAdmin` on development and staging   |
| `KinmapProdDeployers` | `KinmapProdDeploy` on production           |
| `KinmapAuditors`      | `KinmapReadOnly` on all three accounts     |
| `KinmapBreakGlass`    | nothing by default — see break glass above |

Nobody has access until they are a member of one. Add a person with:

```bash
aws identitystore list-users --region us-east-2 --profile kinmap-management \
  --identity-store-id d-xxxxxxxxxx

aws identitystore create-group-membership --region us-east-2 --profile kinmap-management \
  --identity-store-id d-xxxxxxxxxx --group-id <group-id> --member-id UserId=<user-id>
```

Removing somebody is then one membership deletion rather than an archaeology expedition through per-account assignments.

If the identity source is an external IdP, groups arrive over SCIM and cannot be created through the API. The script detects that, records a manual gate, and carries on.

---

## `service-control-policies.sh`

An SCP answers a different question from a permission set: not "what may this person do?" but "what may happen in this account at all, no matter who asks or what IAM says?". It is the control that still holds after a credential leak.

These SCPs are deliberately narrow. They forbid only the actions that destroy evidence, destroy data, or move the workload somewhere nobody is watching. An SCP that tries to express least privilege gets detached the first time it blocks a deploy at 2am, and then nothing is protected.

### `KinmapProductionGuardrails` → Production OU

- `organizations:LeaveOrganization` — an account outside the org has no SCPs at all.
- Disabling CloudTrail (`StopLogging`, `DeleteTrail`, `DeleteEventDataStore`, `StopEventDataStoreIngestion`), GuardDuty (`DeleteDetector`, member disassociation, `DeletePublishingDestination`) and Config (`StopConfigurationRecorder`, `DeleteConfigurationRecorder`, `DeleteDeliveryChannel`, …). Destroying the audit trail is the first move in most incidents, so it is the first thing denied.
- **Re**configuring those services (`UpdateTrail`, `PutEventSelectors`, `UpdateDetector`, `PutConfigurationRecorder`, …) is denied for everyone **except** the CDK CloudFormation execution role. Infrastructure-as-code can still manage the trail; a human at a keyboard cannot narrow it.
- `kms:ScheduleKeyDeletion`, `kms:DisableKey`, `kms:DisableKeyRotation` — deleting the coordinate key is the irreversible loss of every coordinate ever stored.
- `dynamodb:DeleteBackup` and the AWS Backup deletion actions (`DeleteRecoveryPoint`, `DeleteBackupVault`, `DeleteBackupPlan`, `StopBackupJob`, `UpdateRecoveryPointLifecycle`, …) — backups are the only route back from a bad migration.

`dynamodb:UpdateContinuousBackups` is deliberately **not** denied: CloudFormation calls it when creating a table with point-in-time recovery, and IAM cannot distinguish "enabling PITR" from "disabling PITR". Detect that one with a Config rule instead of breaking every deploy.

### `KinmapProductionRegionLock` → Production OU

Denies every regional action outside `us-east-1` and `us-west-2`.

This is not a cost control. Location data is subject to promises made in the privacy policy about where it is stored, and a table quietly created in `ap-south-1` breaks those promises silently.

Global endpoints have no `aws:RequestedRegion`, so IAM, Organizations, STS, Route53, CloudFront, billing — and critically the Identity Center endpoints in `us-east-2` — are listed in `NotAction`. Locking yourself out of sign-in is a self-inflicted outage. Service-linked roles are exempt from SCPs by design, so AWS's own automation keeps working.

It is a separate policy from the guardrails so that adding a region later is a one-policy change that never touches the destructive-action denies.

### `KinmapDenyRootUser` → organization root

Denies every action by the root user, matched on `aws:PrincipalArn` like `arn:aws:iam::*:root`.

SCPs never apply to the management account, so in practice this covers exactly the member accounts — which is the intent. Attaching it at the root is confirmed interactively, because it touches every account in the organization.

The script also warns if `FullAWSAccess` is missing from a target. SCPs are allow-list filters; without it, that scope is deny-by-default and every deploy in it is already broken.

---

## `bootstrap-accounts.sh`

Runs `cdk bootstrap` for each selected environment × region, using the workspace-pinned CDK CLI (`node_modules/.bin/cdk`, currently 2.1134.0) rather than whatever `cdk` happens to be on `PATH` — a different major writes a different bootstrap template.

**It refuses to do anything until the profile is proven.** Before a single API call that changes state:

1. Ambient `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, `AWS_SESSION_TOKEN` and friends are unset. Environment variables outrank profiles in parts of the SDK credential chain, and a forgotten `export AWS_ACCESS_KEY_ID` is exactly how a `--profile kinmap-production` command ends up somewhere else. After this, the only credential source is the named profile.
2. `sts get-caller-identity --profile kinmap-<env>` is compared against the account id Organizations reports for that environment. A mismatch prints a boxed `ACCOUNT MISMATCH — REFUSING TO CONTINUE` and exits non-zero. It is never a warning and never a prompt.
3. Two environments resolving to the same account id is also a hard stop — separate accounts are the isolation boundary of this platform, and an ambiguous mapping means "bootstrap production" could mean development.
4. Regions outside `us-east-1` / `us-west-2` are refused, because the region-lock SCP would deny them halfway through.
5. Production additionally asks for confirmation unless `--yes`.

No credential is ever passed in argv. The AWS CLI reads the SSO token from `~/.aws/sso/cache` itself; these scripts only ever name a profile.

Useful flags:

```bash
./scripts/aws/bootstrap-accounts.sh --env production --region us-east-1
./scripts/aws/bootstrap-accounts.sh --skip-existing
./scripts/aws/bootstrap-accounts.sh --cfn-exec-policy arn:aws:iam::333333333333:policy/KinmapDeployBoundary
```

---

## Recovery

**"Profile has no valid session."**
`aws sso login --profile <name>`. If the browser flow fails, `aws sso logout && aws configure sso --profile <name>` and re-enter the start URL `https://d-xxxxxxxxxx.awsapps.com/start`, region `us-east-2`.

**`ACCOUNT MISMATCH — REFUSING TO CONTINUE`**
The profile resolves to a different account than expected. Either the profile is misconfigured (`~/.aws/config`, check `sso_account_id`) or the expected mapping is wrong (`bootstrap.config.local.json` → `aws.accounts.<env>`). Fix whichever is actually wrong; do not "work around" it.

**"Cannot resolve a 12-digit account id for `<env>`."**
The `kinmap-<env>` account does not exist in Organizations yet and there is no fallback. Create the account, or export `KINMAP_ACCOUNT_ID_<ENV>=…` for a one-off run.

**A script failed halfway.**
Nothing is left in a partial state that a re-run cannot repair: every object is looked up before it is created and every policy is compared before it is written. Fix the reported cause and run the same command again. Run `--dry-run` first to see what is still outstanding.

**An SCP is blocking something legitimate.**

1. Confirm it is the SCP: the error is `AccessDenied` with `explicit deny in a service control policy`, and the same call succeeds from the management account (which SCPs never restrict).
2. Detach, from the management account, and re-attach immediately afterwards:
   ```bash
   aws organizations detach-policy --profile kinmap-management \
     --policy-id <policy-id> --target-id ou-xxxx-xxxxxxxx
   ```
3. Then change the policy document in `service-control-policies.sh` and re-run it, so the fix is in Git rather than in someone's shell history.

**Locked out of every account.**
The management account is the escape hatch: SCPs do not apply to it, and it holds Identity Center. This is the reason it must stay empty of workloads. If the management account itself is unreachable, the AWS account root user of the management account is the last resort — it is deliberately not covered by `KinmapDenyRootUser`, which only reaches member accounts.

**A permission set change appears to have done nothing.**
Permission set edits are inert until they are re-provisioned into the accounts they are assigned to. The script does this automatically (`provision-permission-set --target-type ALL_PROVISIONED_ACCOUNTS`); if you edited one by hand in the console, run `./scripts/aws/permission-sets.sh` to reconcile it.

**Undoing an assignment.**

```bash
aws sso-admin delete-account-assignment --region us-east-2 --profile kinmap-management \
  --instance-arn arn:aws:sso:::instance/ssoins-xxxxxxxxxxxxxxxx \
  --target-id <account-id> --target-type AWS_ACCOUNT \
  --permission-set-arn <ps-arn> --principal-type GROUP --principal-id <group-id>
```

---

## Residual risks, stated plainly

These controls are real, and they are not complete. The gaps are listed here rather than left for someone to discover.

- **A deployer can ship code that reads the data.** `KinmapProdDeploy` cannot read the location tables, but it can deploy a Lambda that can — that is what deploying means. The controls for that are code review, the two-branch release flow, and CloudTrail. Not IAM.
- **The CloudFormation execution role is broader than the human.** `cdk bootstrap` installs a CloudFormation execution role that defaults to `AdministratorAccess`, and CloudFormation acts under that role, not under the deployer's permission set. Narrow it with `--cfn-exec-policy <arn>` pointing at a customer-managed policy carrying the same two denies. `bootstrap-accounts.sh` warns every run while the default is in place.
- **The deny is by table name and key alias.** A table created outside the CDK naming convention, or coordinates written to a store that is not one of the five listed tables, is not covered. `lib/aws-common.sh` holds the single list — `KINMAP_LOCATION_TABLES` — and it must be updated whenever a new store holds coordinates.
- **`kms:ResourceAliases` needs the alias to exist.** The deny is expressed against the key alias so that it works before the key exists and survives key replacement. During a window where the key has no alias, only the explicit-ARN deny applies. The script resolves and pins the real ARN too, whenever it can reach the member account.
- **`ReadOnlyAccess` includes `s3:GetObject`.** Anything derived from location data and written to S3 is protected only if it is encrypted under the coordinate key. Keep it that way.
- **SCPs do not restrict the management account.** Keep it empty of workloads. It is the one account these guardrails cannot cover, which is exactly why it is also the escape hatch.

---

## Constants

All of these live in `lib/aws-common.sh`. They are identifiers, not secrets — an OU id is useless without credentials — and they are hard-coded on purpose, because a typo'd OU id silently attaches a guardrail to the wrong part of the tree.

| Name                     | Value                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------- |
| Management account       | `000000000000`                                                                        |
| Organizations endpoint   | `us-east-1`                                                                           |
| Identity Center region   | `us-east-2`                                                                           |
| Identity Center instance | `arn:aws:sso:::instance/ssoins-xxxxxxxxxxxxxxxx`                                      |
| Identity store           | `d-xxxxxxxxxx`                                                                        |
| OU NonProduction         | `ou-xxxx-xxxxxxxx`                                                                    |
| OU Production            | `ou-xxxx-xxxxxxxx`                                                                    |
| Workload regions         | `us-east-1`, `us-west-2`                                                              |
| CDK bootstrap qualifier  | `hnb659fds`                                                                           |
| Location-bearing tables  | `CurrentLocations`, `LocationHistory`, `SavedPlaces`, `GeofenceState`, `LiveSessions` |
| Coordinate key alias     | `alias/kinmap-<env>-coordinates`                                                      |
