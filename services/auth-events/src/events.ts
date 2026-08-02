/**
 * Cognito user-pool trigger payloads, declared structurally.
 *
 * They are written out here rather than imported from `@types/aws-lambda` so
 * that this service carries no ambient Lambda types and every trigger can be
 * exercised with a plain object literal in a unit test. Only the fields the
 * handlers actually read are modelled; anything else on the event is carried
 * through untouched, because Cognito requires the event to be returned intact.
 */

export type UserAttributes = Readonly<Record<string, string | undefined>>;

/** Free-form string map the client may attach to a Cognito API call. */
export type ClientMetadata = Readonly<Record<string, string | undefined>>;

export type CognitoEventBase = {
  readonly version: string;
  readonly region: string;
  readonly userPoolId: string;
  readonly userName: string;
  readonly callerContext: {
    readonly awsSdkVersion?: string;
    readonly clientId?: string;
  };
};

export const PRE_SIGN_UP_SOURCES = [
  'PreSignUp_SignUp',
  'PreSignUp_AdminCreateUser',
  'PreSignUp_ExternalProvider',
] as const;
export type PreSignUpSource = (typeof PRE_SIGN_UP_SOURCES)[number];

export type PreSignUpEvent = CognitoEventBase & {
  readonly triggerSource: PreSignUpSource;
  readonly request: {
    readonly userAttributes: UserAttributes;
    /** Supplied by `SignUp`; the only channel a native sign-up has. */
    readonly validationData?: ClientMetadata | null;
    readonly clientMetadata?: ClientMetadata | null;
  };
  readonly response: {
    readonly autoConfirmUser?: boolean;
    readonly autoVerifyEmail?: boolean;
    readonly autoVerifyPhone?: boolean;
  };
};

export const POST_CONFIRMATION_SOURCES = [
  'PostConfirmation_ConfirmSignUp',
  'PostConfirmation_ConfirmForgotPassword',
] as const;
export type PostConfirmationSource = (typeof POST_CONFIRMATION_SOURCES)[number];

export type PostConfirmationEvent = CognitoEventBase & {
  readonly triggerSource: PostConfirmationSource;
  readonly request: {
    readonly userAttributes: UserAttributes;
    readonly clientMetadata?: ClientMetadata | null;
  };
  readonly response: Readonly<Record<string, never>>;
};

export const TOKEN_GENERATION_SOURCES = [
  'TokenGeneration_HostedAuth',
  'TokenGeneration_Authentication',
  'TokenGeneration_NewPasswordChallenge',
  'TokenGeneration_AuthenticateDevice',
  'TokenGeneration_RefreshTokens',
] as const;
export type TokenGenerationSource = (typeof TOKEN_GENERATION_SOURCES)[number];

export type PreTokenGenerationEvent = CognitoEventBase & {
  readonly triggerSource: TokenGenerationSource;
  readonly request: {
    readonly userAttributes: UserAttributes;
    readonly groupConfiguration?: {
      readonly groupsToOverride?: readonly string[];
      readonly iamRolesToOverride?: readonly string[];
      readonly preferredRole?: string | null;
    };
    readonly clientMetadata?: ClientMetadata | null;
  };
  readonly response: {
    readonly claimsOverrideDetails?: {
      readonly claimsToAddOrOverride?: Readonly<Record<string, string>>;
      readonly claimsToSuppress?: readonly string[];
      readonly groupOverrideDetails?: {
        readonly groupsToOverride?: readonly string[];
        readonly iamRolesToOverride?: readonly string[];
        readonly preferredRole?: string | null;
      };
    };
  };
};

export const CUSTOM_MESSAGE_SOURCES = [
  'CustomMessage_SignUp',
  'CustomMessage_AdminCreateUser',
  'CustomMessage_ResendCode',
  'CustomMessage_ForgotPassword',
  'CustomMessage_UpdateUserAttribute',
  'CustomMessage_VerifyUserAttribute',
  'CustomMessage_Authentication',
] as const;
export type CustomMessageSource = (typeof CUSTOM_MESSAGE_SOURCES)[number];

export type CustomMessageEvent = CognitoEventBase & {
  readonly triggerSource: CustomMessageSource;
  readonly request: {
    readonly userAttributes: UserAttributes;
    /** Placeholder Cognito substitutes with the real code. Must be echoed verbatim. */
    readonly codeParameter: string;
    readonly usernameParameter?: string | null;
    readonly linkParameter?: string | null;
    readonly clientMetadata?: ClientMetadata | null;
  };
  readonly response: {
    readonly smsMessage?: string;
    readonly emailMessage?: string;
    readonly emailSubject?: string;
  };
};

export type CognitoTriggerEvent =
  PreSignUpEvent | PostConfirmationEvent | PreTokenGenerationEvent | CustomMessageEvent;

/**
 * An event whose `triggerSource` has not been narrowed yet. The handler reads
 * that one field, then dispatches to a typed branch.
 */
export type UnknownTriggerEvent = CognitoEventBase & {
  readonly triggerSource: string;
  readonly request?: Readonly<Record<string, unknown>>;
  readonly response?: Readonly<Record<string, unknown>>;
};

export function isPreSignUp(event: UnknownTriggerEvent): event is PreSignUpEvent {
  return (PRE_SIGN_UP_SOURCES as readonly string[]).includes(event.triggerSource);
}

export function isPostConfirmation(event: UnknownTriggerEvent): event is PostConfirmationEvent {
  return (POST_CONFIRMATION_SOURCES as readonly string[]).includes(event.triggerSource);
}

export function isTokenGeneration(event: UnknownTriggerEvent): event is PreTokenGenerationEvent {
  return (TOKEN_GENERATION_SOURCES as readonly string[]).includes(event.triggerSource);
}

export function isCustomMessage(event: UnknownTriggerEvent): event is CustomMessageEvent {
  return (CUSTOM_MESSAGE_SOURCES as readonly string[]).includes(event.triggerSource);
}
