import { z } from 'zod';

import { DeviceIdSchema, TrackingStateSchema, UserIdSchema } from '@family/contracts';

import {
  AppVersionSchema,
  IsoDateTimeSchema,
  LocaleSchema,
  PlatformSchema,
  StrictDeviceLocationHealthSchema,
  TimeZoneSchema,
} from './common.js';

/**
 * Device endpoints.
 *
 * `POST   /v1/devices`
 * `GET    /v1/devices`
 * `PATCH  /v1/devices/{deviceId}`
 * `DELETE /v1/devices/{deviceId}`
 *
 * A push token is a credential-grade value: accepted on write, never echoed on
 * read, never logged. Responses expose only `pushTokenRegistered`.
 */

/** APNs hex token or FCM registration token. */
export const PushTokenSchema = z.string().min(32).max(4096);

export const DeviceStatusSchema = z.enum(['ACTIVE', 'INACTIVE', 'REVOKED']);
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

// ---------------------------------------------------------------------------
// POST /v1/devices
// ---------------------------------------------------------------------------

export const RegisterDeviceRequestSchema = z.strictObject({
  /** Client-generated UUID; re-registering the same id is idempotent. */
  deviceId: DeviceIdSchema,
  platform: PlatformSchema,
  osVersion: z.string().min(1).max(40),
  appVersion: AppVersionSchema,
  appBuild: z.string().min(1).max(40),
  /** e.g. "iPhone16,2". Not a user-chosen name. */
  modelIdentifier: z.string().min(1).max(80),
  deviceName: z.string().min(1).max(80).nullable().default(null),
  pushToken: PushTokenSchema.nullable().default(null),
  locale: LocaleSchema,
  timeZone: TimeZoneSchema,
  health: StrictDeviceLocationHealthSchema.optional(),
});
export type RegisterDeviceRequest = z.infer<typeof RegisterDeviceRequestSchema>;

export const DeviceSchema = z.strictObject({
  deviceId: DeviceIdSchema,
  userId: UserIdSchema,
  platform: PlatformSchema,
  osVersion: z.string(),
  appVersion: z.string(),
  appBuild: z.string(),
  modelIdentifier: z.string(),
  deviceName: z.string().nullable(),
  status: DeviceStatusSchema,
  /** Never the token itself. */
  pushTokenRegistered: z.boolean(),
  trackingState: TrackingStateSchema,
  locale: LocaleSchema,
  timeZone: TimeZoneSchema,
  registeredAt: IsoDateTimeSchema,
  lastSeenAt: IsoDateTimeSchema.nullable(),
  lastUploadAt: IsoDateTimeSchema.nullable(),
  isCurrentDevice: z.boolean(),
});
export type Device = z.infer<typeof DeviceSchema>;

export const RegisterDeviceResponseSchema = z.strictObject({
  device: DeviceSchema,
  /** Remote configuration version the device should fetch next. */
  configVersion: z.number().int().nonnegative(),
});
export type RegisterDeviceResponse = z.infer<typeof RegisterDeviceResponseSchema>;

// ---------------------------------------------------------------------------
// GET /v1/devices
// ---------------------------------------------------------------------------

export const ListDevicesResponseSchema = z.strictObject({
  devices: z.array(DeviceSchema),
});
export type ListDevicesResponse = z.infer<typeof ListDevicesResponseSchema>;

// ---------------------------------------------------------------------------
// PATCH /v1/devices/{deviceId}
// ---------------------------------------------------------------------------

export const DevicePathSchema = z.strictObject({
  deviceId: DeviceIdSchema,
});
export type DevicePath = z.infer<typeof DevicePathSchema>;

export const UpdateDeviceRequestSchema = z
  .strictObject({
    deviceName: z.string().min(1).max(80).nullable().optional(),
    /** Pass null to clear the token when notifications are turned off. */
    pushToken: PushTokenSchema.nullable().optional(),
    appVersion: AppVersionSchema.optional(),
    appBuild: z.string().min(1).max(40).optional(),
    osVersion: z.string().min(1).max(40).optional(),
    locale: LocaleSchema.optional(),
    timeZone: TimeZoneSchema.optional(),
    health: StrictDeviceLocationHealthSchema.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'At least one field must be provided.',
  });
export type UpdateDeviceRequest = z.infer<typeof UpdateDeviceRequestSchema>;

export const UpdateDeviceResponseSchema = z.strictObject({
  device: DeviceSchema,
  configVersion: z.number().int().nonnegative(),
});
export type UpdateDeviceResponse = z.infer<typeof UpdateDeviceResponseSchema>;

// ---------------------------------------------------------------------------
// DELETE /v1/devices/{deviceId}
// ---------------------------------------------------------------------------

export const RevokeDeviceResponseSchema = z.strictObject({
  deviceId: DeviceIdSchema,
  status: z.literal('REVOKED'),
  revokedAt: IsoDateTimeSchema,
  /** Queued points on that device are discarded, never uploaded after revoke. */
  discardedPendingEvents: z.boolean(),
});
export type RevokeDeviceResponse = z.infer<typeof RevokeDeviceResponseSchema>;
