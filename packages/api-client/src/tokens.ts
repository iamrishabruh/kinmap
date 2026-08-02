/**
 * Single-flight bearer-token management.
 *
 * The failure mode this exists to prevent: the app wakes from background, fires
 * six requests at once, every one gets a 401, and every one independently calls
 * the refresh endpoint. That is a refresh storm — it burns the refresh token's
 * one-time use, races itself into a signed-out state, and looks like an attack
 * to the backend.
 *
 * Two guards:
 *   1. Concurrent refreshes share one in-flight promise.
 *   2. A caller holding an already-superseded token is handed the current one
 *      instead of triggering another round trip.
 */

export type TokenProviderOptions = {
  getAccessToken: () => string | null | Promise<string | null>;
  refreshAccessToken?: () => Promise<string | null>;
  onRefreshFailed?: (error: unknown) => void;
};

export class TokenManager {
  readonly #getAccessToken: TokenProviderOptions['getAccessToken'];
  readonly #refreshAccessToken: TokenProviderOptions['refreshAccessToken'];
  readonly #onRefreshFailed: TokenProviderOptions['onRefreshFailed'];

  #inFlight: Promise<string | null> | null = null;
  #lastRefreshed: string | null = null;

  constructor(options: TokenProviderOptions) {
    this.#getAccessToken = options.getAccessToken;
    this.#refreshAccessToken = options.refreshAccessToken;
    this.#onRefreshFailed = options.onRefreshFailed;
  }

  get canRefresh(): boolean {
    return typeof this.#refreshAccessToken === 'function';
  }

  /** The token to attach to the next attempt, or null when signed out. */
  async get(): Promise<string | null> {
    return (await this.#getAccessToken()) ?? null;
  }

  /**
   * @param staleToken the token that just produced a 401.
   * @returns the token to retry with, or null if the session is unrecoverable.
   */
  async refresh(staleToken: string | null): Promise<string | null> {
    const refreshAccessToken = this.#refreshAccessToken;
    if (!refreshAccessToken) return null;

    // Another request already replaced this token while we were in flight —
    // retry with theirs instead of spending a second refresh.
    if (this.#lastRefreshed !== null && this.#lastRefreshed !== staleToken) {
      return this.#lastRefreshed;
    }

    const existing = this.#inFlight;
    if (existing) return existing;

    const inFlight = Promise.resolve()
      .then(() => refreshAccessToken())
      .then((token) => {
        const resolved = token ?? null;
        if (resolved !== null) this.#lastRefreshed = resolved;
        return resolved;
      })
      .catch((error: unknown) => {
        // A failed refresh is a signed-out signal, not an exception the caller
        // should have to handle in the middle of an unrelated request.
        this.#onRefreshFailed?.(error);
        return null;
      })
      .finally(() => {
        if (this.#inFlight === inFlight) this.#inFlight = null;
      });

    this.#inFlight = inFlight;
    return inFlight;
  }

  /** Test/sign-out hook: forgets what we know about the current session. */
  reset(): void {
    this.#inFlight = null;
    this.#lastRefreshed = null;
  }
}
