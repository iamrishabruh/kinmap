import { env } from '@/config/env';

/**
 * Where tokens come from.
 *
 * The API deliberately exposes no unauthenticated token endpoint — see the
 * comment above `API_ROUTES` in `infrastructure/stacks/api-stack.ts`. There is
 * no `/v1/auth/*` and there never will be one. Access and refresh tokens are
 * issued, rotated and revoked against the Cognito user pool itself, and the API
 * only ever verifies the resulting access token (`packages/auth`'s
 * `createCognitoAccessTokenVerifier`, `tokenUse: 'access'`).
 *
 * Everything this module needs is public: a pool id, an app client id and a
 * hosted-UI host. All three are embedded in the binary and readable by anyone
 * (spec §29). The app client has NO secret — deliberately, because a mobile
 * binary cannot keep one — which is why the password flow is SRP and the
 * federated flow is PKCE. Neither ever transmits something a client secret
 * would have protected.
 *
 * The three values are resolved together rather than one at a time. A pool id
 * from one environment paired with a client id from another is a configuration
 * error, and it must fail here, naming the variable to set, instead of
 * surfacing later as an indistinguishable "incorrect email or password".
 */

/**
 * Mirrors `APP_URL_SCHEME` in `infrastructure/stacks/identity-stack.ts`. The
 * app client's callback list is built from it, so the binary must register the
 * same scheme or the hosted UI's redirect is delivered to nothing.
 */
const APP_URL_SCHEME = 'kinmap';

/** `us-east-1_XXXXXXXXX` → region `us-east-1`, pool name `XXXXXXXXX`. */
const USER_POOL_ID = /^((?:[a-z]{2}(?:-[a-z]+)+-\d))_([A-Za-z0-9]+)$/;

export type CognitoConfig = {
  readonly userPoolId: string;
  /**
   * The part after the underscore. Not cosmetic: the SRP handshake mixes it
   * into the salted password hash and into the signed message, so a wrong pool
   * name produces a signature the pool rejects with the same opaque error as a
   * wrong password.
   */
  readonly userPoolName: string;
  readonly region: string;
  readonly clientId: string;
  /** JSON-1.1 identity-provider endpoint: InitiateAuth and friends. */
  readonly idpEndpoint: string;
  /** Hosted-UI origin, e.g. `https://<prefix>.auth.<region>.amazoncognito.com`. */
  readonly hostedUiOrigin: string;
  /** Must appear verbatim in the app client's `CallbackURLs`. */
  readonly redirectUri: string;
  /** Must appear verbatim in the app client's `LogoutURLs`. */
  readonly signOutUri: string;
};

/**
 * Raised when the build has no usable pool configuration. Separate from
 * `AppError` on purpose: this is never a state a user can be in on a correctly
 * built binary, so it must not be rendered as an ordinary sign-in failure.
 */
export class CognitoConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CognitoConfigurationError';
  }
}

function missing(key: string, variable: string): CognitoConfigurationError {
  // The value itself is never included: these are long identifiers that end up
  // in crash reports, and the reader needs the variable name, not its content.
  return new CognitoConfigurationError(
    `Missing public configuration "${key}". Set ${variable} in EAS environment ` +
      `variables or apps/mobile/.env.local and rebuild.`,
  );
}

export type CognitoConfigSource = {
  userPoolId: string | undefined;
  clientId: string | undefined;
  /** Domain prefix, bare host, or full URL — all three forms are accepted. */
  domain: string | undefined;
};

/**
 * Builds the configuration from raw public values.
 *
 * Exported separately from {@link cognitoConfig} so the resolution rules can be
 * tested without a running Expo runtime.
 */
export function resolveCognitoConfig(source: CognitoConfigSource): CognitoConfig {
  const userPoolId = source.userPoolId?.trim() ?? '';
  if (userPoolId.length === 0) {
    throw missing('cognitoUserPoolId', 'COGNITO_USER_POOL_ID');
  }

  const parts = USER_POOL_ID.exec(userPoolId);
  const region = parts?.[1];
  const userPoolName = parts?.[2];
  if (region === undefined || userPoolName === undefined) {
    // The region is derived from the pool id rather than read from AWS_REGION.
    // Two independent sources of the same fact can disagree; one cannot.
    throw new CognitoConfigurationError(
      'Public configuration "cognitoUserPoolId" is not a Cognito user pool id. ' +
        "Set COGNITO_USER_POOL_ID to the value of the identity stack's UserPoolId output.",
    );
  }

  const clientId = source.clientId?.trim() ?? '';
  if (clientId.length === 0) {
    throw missing('cognitoClientId', 'COGNITO_CLIENT_ID');
  }

  return {
    userPoolId,
    userPoolName,
    region,
    clientId,
    idpEndpoint: `https://cognito-idp.${region}.amazonaws.com/`,
    hostedUiOrigin: resolveHostedUiOrigin(source.domain, region),
    redirectUri: `${APP_URL_SCHEME}://auth/callback`,
    signOutUri: `${APP_URL_SCHEME}://auth/signout`,
  };
}

/**
 * `COGNITO_DOMAIN` is populated from the identity stack's `HostedUiUrl` output
 * in some environments and from the bare domain prefix in others. Rather than
 * make the build depend on which, all three shapes resolve to the same origin.
 */
function resolveHostedUiOrigin(domain: string | undefined, region: string): string {
  const value = domain?.trim() ?? '';
  if (value.length === 0) {
    throw missing('cognitoDomain', 'COGNITO_DOMAIN');
  }
  const withoutScheme = value.replace(/^https?:\/\//u, '').replace(/\/+$/u, '');
  const origin = withoutScheme.includes('.')
    ? withoutScheme
    : `${withoutScheme}.auth.${region}.amazoncognito.com`;
  return `https://${origin}`;
}

let resolved: CognitoConfig | null = null;

/**
 * The pool this build talks to. Resolved once, on first use — never at import
 * time, so a developer with an unpopulated `.env.local` still reaches a screen
 * that explains what is missing instead of a blank crash on launch.
 */
export function cognitoConfig(): CognitoConfig {
  resolved ??= resolveCognitoConfig({
    userPoolId: env.cognitoUserPoolId,
    clientId: env.cognitoClientId,
    domain: env.cognitoDomain,
  });
  return resolved;
}

/** Test seam. */
export function resetCognitoConfig(): void {
  resolved = null;
}

/**
 * Token lifetimes.
 *
 * Cognito states the access token's expiry in the token itself, so that one is
 * read from the claim rather than assumed. It says nothing about the refresh
 * token — that is an opaque, encrypted blob with no readable expiry — so this
 * value has to mirror `refreshTokenValidity` on the app client in
 * `identity-stack.ts`. It is used only to skip a round trip on a refresh token
 * we can already see is dead; being wrong in the long direction costs one
 * rejected request, and the number is therefore deliberately not padded down.
 */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * `authSessionValidity` on the app client: how long a Cognito challenge session
 * stays answerable. Surfaced to the UI as the challenge's expiry so a user who
 * walks away is told the code window closed rather than shown a generic error.
 */
export const CHALLENGE_SESSION_TTL_MS = 3 * 60 * 1000;
