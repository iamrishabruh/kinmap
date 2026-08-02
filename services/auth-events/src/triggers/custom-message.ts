import type { AuthEventsConfig } from '../env.js';
import type { CustomMessageEvent, CustomMessageSource } from '../events.js';

/**
 * Custom messages.
 *
 * Nothing user-specific is interpolated. The only substitutions are Cognito's
 * own `codeParameter` placeholder and the environment's domain, both of which
 * come from the server. In particular the recipient's address and name are not
 * echoed back into the body: an email is forwarded, quoted and screenshotted,
 * and in a product where a message means "somebody is setting up location
 * sharing" the body should say as little as possible.
 *
 * The code placeholder must be reproduced verbatim — Cognito substitutes the
 * real value after the trigger returns, and a message without it is delivered
 * with no code in it at all.
 */

const PRODUCT = 'KinMap';

type Message = { readonly subject: string; readonly body: string; readonly sms: string };

function messageFor(source: CustomMessageSource, code: string, appDomain: string): Message {
  const footer =
    `If you did not request this, you can ignore this email. ` +
    `Learn more at https://${appDomain}/security.`;

  switch (source) {
    case 'CustomMessage_ForgotPassword':
      return {
        subject: `${PRODUCT} password reset code`,
        body: `Your ${PRODUCT} password reset code is ${code}. It expires shortly. ${footer}`,
        sms: `${PRODUCT} password reset code: ${code}`,
      };
    case 'CustomMessage_ResendCode':
      return {
        subject: `${PRODUCT} verification code`,
        body: `Here is your ${PRODUCT} verification code again: ${code}. It expires shortly. ${footer}`,
        sms: `${PRODUCT} verification code: ${code}`,
      };
    case 'CustomMessage_UpdateUserAttribute':
    case 'CustomMessage_VerifyUserAttribute':
      return {
        subject: `${PRODUCT} confirmation code`,
        body:
          `Use ${code} to confirm this change to your ${PRODUCT} account. ` +
          `We will keep using your previous email address until the new one is confirmed. ${footer}`,
        sms: `${PRODUCT} confirmation code: ${code}`,
      };
    case 'CustomMessage_Authentication':
      return {
        subject: `${PRODUCT} sign-in code`,
        body: `Your ${PRODUCT} sign-in code is ${code}. It expires shortly. ${footer}`,
        sms: `${PRODUCT} sign-in code: ${code}`,
      };
    case 'CustomMessage_AdminCreateUser':
      return {
        subject: `Your ${PRODUCT} account`,
        body:
          `An account has been created for you on ${PRODUCT}. ` +
          `Your temporary password is ${code}. ` +
          `Sign in at https://${appDomain} to choose your own. ${footer}`,
        sms: `${PRODUCT} temporary password: ${code}`,
      };
    case 'CustomMessage_SignUp':
      return {
        subject: `${PRODUCT} verification code`,
        body:
          `Welcome to ${PRODUCT}. Your verification code is ${code}. It expires shortly. ` +
          `${PRODUCT} only shares your location with people you choose, and you can pause it at any time. ${footer}`,
        sms: `${PRODUCT} verification code: ${code}`,
      };
  }
}

export function handleCustomMessage(
  event: CustomMessageEvent,
  config: AuthEventsConfig,
): CustomMessageEvent {
  const message = messageFor(event.triggerSource, event.request.codeParameter, config.appDomain);

  return {
    ...event,
    response: {
      ...event.response,
      emailSubject: message.subject,
      emailMessage: message.body,
      smsMessage: message.sms,
    },
  };
}
