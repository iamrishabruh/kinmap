import type { DeviceLocationHealth, NativeLocationEngine } from '@family/contracts';

/**
 * Access to the native background-location engine from the settings surface.
 *
 * The Swift/Kotlin implementation and its Expo module wrapper are owned by the
 * location half of the app. This module is the seam: the host registers the
 * real engine once at startup, and every settings screen depends only on the
 * `NativeLocationEngine` interface from `@family/contracts` — never on a
 * concrete module. That keeps the privacy screens buildable and testable on a
 * simulator, in Jest, and on web, where no engine exists.
 */

let engine: NativeLocationEngine | null = null;

export function registerLocationEngine(next: NativeLocationEngine | null): void {
  engine = next;
}

export function getLocationEngine(): NativeLocationEngine | null {
  return engine;
}

/**
 * Health as reported by the device itself.
 *
 * Returns null when no engine is registered — the troubleshooting screen shows
 * an explicit "we cannot read your device's status" state rather than inventing
 * a healthy-looking one. Telling a user everything is fine when we do not know
 * is exactly the failure mode this product cannot have.
 */
export async function readDeviceHealth(): Promise<DeviceLocationHealth | null> {
  if (!engine) return null;
  return engine.getDeviceHealth();
}

/**
 * Stops location collection on this device right now.
 *
 * Called before the server round-trip on pause, and unconditionally on
 * sign-out, membership loss, device revocation and account deletion. A failure
 * here is swallowed by the caller on purpose: the server-side pause is the
 * authoritative one, and a native error must never block a user from leaving.
 */
export async function pauseNativeSharing(): Promise<void> {
  await engine?.pauseSharing();
}

export async function resumeNativeSharing(): Promise<void> {
  await engine?.resumeSharing();
}

/**
 * Best-effort upload of anything still queued on this device, used by the
 * troubleshooting screen's "try to send now" action.
 */
export async function flushPendingEvents(): Promise<{
  uploadedCount: number;
  remainingCount: number;
  lastError: string | null;
} | null> {
  if (!engine) return null;
  const result = await engine.flushPendingEvents();
  return {
    uploadedCount: result.uploadedCount,
    remainingCount: result.remainingCount,
    // Already sanitised by contract: FlushResult.lastError never carries a fix.
    lastError: result.lastError,
  };
}
