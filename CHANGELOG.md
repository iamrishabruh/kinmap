# Changelog

Notable changes to the Family Location platform. Managed by
[Changesets](https://github.com/changesets/changesets) — add one with
`pnpm changeset` for any user-visible change.

The production deploy workflow refuses to run if this file is missing, so it is
committed from the first release onward.

## Unreleased

### Added

- Initial repository bootstrap: pnpm + Turborepo monorepo, Expo SDK 57 mobile
  application with committed native projects, AWS CDK v2 infrastructure, backend
  Lambda services, shared contract packages, CI workflows, and the phased
  bootstrap script.

### Not yet released

Nothing has been deployed to any AWS account or submitted to any app store. See
`docs/operations/execution-report.md` for the current provisioning status and the
list of outstanding manual gates.
