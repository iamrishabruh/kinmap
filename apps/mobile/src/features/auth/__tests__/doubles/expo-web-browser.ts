export type WebBrowserAuthSessionResult =
  { type: 'success'; url: string } | { type: 'cancel' | 'dismiss' };

type Responder = (url: string, redirectUrl?: string | null) => WebBrowserAuthSessionResult;

let responder: Responder = () => ({ type: 'cancel' });
let lastUrl = '';

export async function openAuthSessionAsync(
  url: string,
  redirectUrl?: string | null,
): Promise<WebBrowserAuthSessionResult> {
  lastUrl = url;
  return responder(url, redirectUrl);
}

/** The last authorize URL the code under test asked the browser to open. */
export function lastAuthorizeUrl(): string {
  return lastUrl;
}

export function __respondWith(next: Responder): void {
  responder = next;
}

export function __reset(): void {
  responder = () => ({ type: 'cancel' });
  lastUrl = '';
}
