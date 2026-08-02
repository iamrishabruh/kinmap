import type { DeviceId, UserId } from '@family/contracts';
import type { Device, RegisterDeviceRequest, UpdateDeviceRequest } from '@family/schemas';

import type { DevicePatch, DeviceRecord } from '../repositories/devices.js';

/**
 * Device registration and projection.
 *
 * The push token is the sensitive part. It is accepted on write, stored for the
 * notification service, and never leaves this service again: `projectDevice`
 * emits `pushTokenRegistered`, a boolean, and there is no code path that puts
 * the token into a response or a log field.
 */

export function buildDeviceRecord(input: {
  userId: UserId;
  request: RegisterDeviceRequest;
  existing: DeviceRecord | null;
  now: Date;
}): DeviceRecord {
  const timestamp = input.now.toISOString();
  const { request } = input;

  return {
    userId: input.userId,
    deviceId: request.deviceId,
    platform: request.platform,
    osVersion: request.osVersion,
    appVersion: request.appVersion,
    appBuild: request.appBuild,
    modelIdentifier: request.modelIdentifier,
    deviceName: request.deviceName,
    // Re-registering re-activates a device that had merely gone quiet, but a
    // REVOKED device stays revoked: revocation is a security decision and the
    // client cannot undo it by repeating the registration call.
    status: input.existing?.status === 'REVOKED' ? 'REVOKED' : 'ACTIVE',
    pushToken: request.pushToken ?? input.existing?.pushToken ?? null,
    trackingState:
      request.health?.trackingState ?? input.existing?.trackingState ?? 'PERMISSION_REQUIRED',
    locale: request.locale,
    timeZone: request.timeZone,
    health: request.health ?? input.existing?.health ?? null,
    // Preserved so a re-registration does not reset the device's age.
    registeredAt: input.existing?.registeredAt ?? timestamp,
    updatedAt: timestamp,
    lastSeenAt: timestamp,
    lastUploadAt: input.existing?.lastUploadAt ?? null,
    revokedAt: input.existing?.revokedAt ?? null,
  };
}

export function toDevicePatch(request: UpdateDeviceRequest): DevicePatch {
  return {
    deviceName: request.deviceName,
    pushToken: request.pushToken,
    appVersion: request.appVersion,
    appBuild: request.appBuild,
    osVersion: request.osVersion,
    locale: request.locale,
    timeZone: request.timeZone,
    health: request.health,
    trackingState: request.health?.trackingState,
  };
}

export function projectDevice(record: DeviceRecord, currentDeviceId: DeviceId | null): Device {
  return {
    deviceId: record.deviceId,
    userId: record.userId,
    platform: record.platform,
    osVersion: record.osVersion,
    appVersion: record.appVersion,
    appBuild: record.appBuild,
    modelIdentifier: record.modelIdentifier,
    deviceName: record.deviceName,
    status: record.status,
    pushTokenRegistered: record.pushToken !== null,
    trackingState: record.trackingState,
    locale: record.locale,
    timeZone: record.timeZone,
    registeredAt: record.registeredAt,
    lastSeenAt: record.lastSeenAt,
    lastUploadAt: record.lastUploadAt,
    isCurrentDevice: currentDeviceId !== null && currentDeviceId === record.deviceId,
  };
}
