# AWS accounts and access

The account layout, the permission sets, and — more importantly — why access is
scoped the way it is.

## Account layout

Organization `o-xxxxxxxxxx`, root `r-xxxx`.

| Account              | ID           | OU            | Purpose                                                                            |
| -------------------- | ------------ | ------------- | ---------------------------------------------------------------------------------- |
| `rishabh`            | 000000000000 | Root          | Management. Organizations, Identity Center, billing. **No application workloads.** |
| `kinmap-development` | 000000000000 | NonProduction | Day-to-day development                                                             |
| `kinmap-staging`     | 000000000000 | NonProduction | Pre-production verification                                                        |
| `kinmap-production`  | 000000000000 | Production    | Real users, real location data                                                     |

Separate accounts rather than separate stacks in one account, because an account
is the only boundary AWS genuinely enforces. A mistaken `cdk deploy` in a
development shell cannot reach production data, and a compromised development
credential grants nothing in production.

Member account emails use Gmail plus-addressing
(`rchouhan.network+kinmap-<env>@gmail.com`), which satisfies AWS's
unique-email-per-account requirement while delivering to one inbox.

## Identity Center

Instance `arn:aws:sso:::instance/ssoins-xxxxxxxxxxxxxxxx`, identity store
`d-xxxxxxxxxx`, **region `us-east-2`**.

> The Identity Center region is independent of the region resources deploy into
> (`us-east-1`). Setting `sso_region` to the deployment region is the usual
> cause of "login succeeded but no roles are offered" — the login works, and
> then there is nothing to select.

Start URL: `https://d-xxxxxxxxxx.awsapps.com/start`

## Permission sets

| Name                   | Session | Assigned to                      | Capability                            |
| ---------------------- | ------- | -------------------------------- | ------------------------------------- |
| `KinmapAdmin`          | 8h      | development, staging, management | `AdministratorAccess`                 |
| `KinmapProdDeploy`     | 1h      | production                       | `PowerUserAccess` minus location data |
| `KinmapReadOnly`       | 4h      | production                       | `ReadOnlyAccess` minus location data  |
| `KinmapProdBreakGlass` | 1h      | **nobody**                       | `AdministratorAccess` on production   |

### Why production access cannot read location data

This product stores where people are. Deploying the infrastructure and reading
the rows inside it are different privileges, and only the first one is needed to
ship. So `KinmapProdDeploy` and `KinmapReadOnly` both carry an inline policy that
**denies**:

- `dynamodb:GetItem`, `BatchGetItem`, `Query`, `Scan`, `PartiQLSelect` and
  `ExportTableToPointInTime` on `CurrentLocations`, `LocationHistory`,
  `SavedPlaces`, `GeofenceState` and `LiveSessions`;
- `kms:Decrypt` and `kms:GenerateDataKey` against the coordinate key alias —
  so even an exported table is ciphertext;
- stopping CloudTrail, GuardDuty or AWS Config.

An explicit `Deny` beats any `Allow`, including `AdministratorAccess`. The
routine production role can create, alter and delete those tables — it simply
cannot look inside them.

This is what the product promises users, expressed as an IAM policy rather than
as a note in a runbook.

### Break glass

`KinmapProdBreakGlass` is full administrator access to production and is
deliberately **not assigned to anyone**. Getting it requires an explicit
assignment, which is itself a conspicuous CloudTrail event:

```bash
aws sso-admin create-account-assignment --region us-east-2 \
  --instance-arn arn:aws:sso:::instance/ssoins-xxxxxxxxxxxxxxxx \
  --target-id 000000000000 --target-type AWS_ACCOUNT \
  --permission-set-arn arn:aws:sso:::permissionSet/ssoins-xxxxxxxxxxxxxxxx/ps-xxxxxxxxxxxxxxxx \
  --principal-type USER --principal-id 516b7590-f0b1-7041-532f-65c858ed0e5f
```

Remove the assignment when the incident is over — use
`delete-account-assignment` with the same arguments. If a break-glass assignment
outlives an incident, the whole scoping exercise is undone.

## Daily use

```bash
aws sso login --profile kinmap-development     # one login covers every profile
```

| Profile                      | Account      | Role             |
| ---------------------------- | ------------ | ---------------- |
| `kinmap-development`         | 000000000000 | KinmapAdmin      |
| `kinmap-staging`             | 000000000000 | KinmapAdmin      |
| `kinmap-production`          | 000000000000 | KinmapProdDeploy |
| `kinmap-production-readonly` | 000000000000 | KinmapReadOnly   |
| `kinmap-management`          | 000000000000 | KinmapAdmin      |

Verify with `aws sts get-caller-identity --profile <profile>` — the ARN names
the role, so it is obvious which hat you are wearing.

## Root user

Root was used once, to enable Identity Center, and then locked with MFA. It
bypasses every control on this page: the location-data deny, the SCPs, the
permission-set boundaries. Nothing routine should ever need it.

The few things that genuinely require root are documented by AWS: closing the
account, changing the account name or email, and some billing operations.

## CI

GitHub Actions authenticates by OIDC federation, never with stored keys. The
deploy role is created by `FoundationStack` and trusts
`repo:iamrishabruh/kinmap`. There are no long-lived AWS access keys anywhere in
this project — not in the repository, not in GitHub secrets, not on a developer
machine.

## What is deliberately not done yet

- **No SCPs are attached.** `scripts/aws/service-control-policies.sh` creates
  them; they are not applied until the accounts carry something worth protecting.
  Development now carries fifteen stacks, so this is worth revisiting.
- **All three environments share one Route 53 hosted zone** in the management
  account (`Z00000000000000000`), with development and staging as subdomains.
  Splitting DNS per account is worth doing before production carries real users.
- **Billing alerts are per-account** via the CDK `FoundationStack` budgets; there
  is no consolidated anomaly detector across the organization yet.
