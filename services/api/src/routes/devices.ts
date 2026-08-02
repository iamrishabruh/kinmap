import { AppError } from '@family/contracts';
import {
  DevicePathSchema,
  RegisterDeviceRequestSchema,
  UpdateDeviceRequestSchema,
  type ListDevicesResponse,
  type RegisterDeviceResponse,
  type RevokeDeviceResponse,
  type UpdateDeviceResponse,
} from '@family/schemas';

import { buildDeviceRecord, projectDevice, toDevicePatch } from '../domain/devices.js';
import { validateBody, validateParams } from '../middleware/validation.js';
import { defineRoute, type RegisteredRoute } from '../router.js';
import type { AnyRouteContext } from '../types.js';

import { requireAuth, writeAudit } from './shared.js';

/**
 * Device endpoints.
 *
 * Every lookup is scoped by the caller's user id, so a device id alone is never
 * enough to reach a row — a stolen or guessed id leaks neither its owner nor its
 * existence. Revocation is one-way: re-registering the same id does not
 * resurrect a revoked device, because revocation is a security decision and the
 * client is not the one that gets to reverse it.
 */

async function currentConfigVersion(context: AnyRouteContext): Promise<number> {
  const configuration = await context.services.configuration.getEngineConfiguration();
  return configuration?.configVersion ?? 0;
}

export const deviceRoutes: RegisteredRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/v1/devices',
    authRequired: true,
    entitlement: null,
    rateLimit: 'GENERAL_READ',
    idempotencyRequired: false,
    async handler(context) {
      const auth = requireAuth(context);
      const devices = await context.services.devices.list(auth.userId);
      const response: ListDevicesResponse = {
        devices: devices.map((device) => projectDevice(device, auth.deviceId)),
      };
      return { statusCode: 200, body: response };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/v1/devices',
    authRequired: true,
    entitlement: null,
    rateLimit: 'ACCOUNT_MUTATION',
    idempotencyRequired: true,
    async handler(context) {
      const auth = requireAuth(context);
      const request = validateBody(RegisterDeviceRequestSchema, context.body);

      const existing = await context.services.devices.get({
        userId: auth.userId,
        deviceId: request.deviceId,
      });
      if (existing?.status === 'REVOKED') {
        throw new AppError('DEVICE_REVOKED', 'This device has been revoked.');
      }

      const record = buildDeviceRecord({
        userId: auth.userId,
        request,
        existing,
        now: context.now,
      });
      await context.services.devices.upsert(record);

      if (existing === null) {
        await writeAudit(context, {
          action: 'DEVICE_REGISTERED',
          targetUserId: auth.userId,
          metadata: { platform: record.platform, appVersion: record.appVersion },
        });
      }

      const response: RegisterDeviceResponse = {
        device: projectDevice(record, auth.deviceId),
        configVersion: await currentConfigVersion(context),
      };
      return { statusCode: existing === null ? 201 : 200, body: response };
    },
  }),

  defineRoute({
    method: 'PATCH',
    path: '/v1/devices/{deviceId}',
    authRequired: true,
    entitlement: null,
    rateLimit: 'ACCOUNT_MUTATION',
    idempotencyRequired: false,
    async handler(context) {
      const auth = requireAuth(context);
      const path = validateParams(DevicePathSchema, context.params);
      const request = validateBody(UpdateDeviceRequestSchema, context.body);

      const existing = await context.services.devices.get({
        userId: auth.userId,
        deviceId: path.deviceId,
      });
      if (existing === null) {
        throw new AppError('NOT_FOUND', 'No such device.');
      }
      if (existing.status === 'REVOKED') {
        throw new AppError('DEVICE_REVOKED', 'This device has been revoked.');
      }

      const updated = await context.services.devices.update({
        userId: auth.userId,
        deviceId: path.deviceId,
        patch: toDevicePatch(request),
        now: context.now,
      });
      if (updated === null) {
        // Lost the race with a revocation between the read and the write.
        throw new AppError('DEVICE_REVOKED', 'This device has been revoked.');
      }

      const response: UpdateDeviceResponse = {
        device: projectDevice(updated, auth.deviceId),
        configVersion: await currentConfigVersion(context),
      };
      return { statusCode: 200, body: response };
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/v1/devices/{deviceId}',
    authRequired: true,
    entitlement: null,
    rateLimit: 'ACCOUNT_MUTATION',
    idempotencyRequired: false,
    async handler(context) {
      const auth = requireAuth(context);
      const path = validateParams(DevicePathSchema, context.params);

      const revoked = await context.services.devices.revoke({
        userId: auth.userId,
        deviceId: path.deviceId,
        now: context.now,
      });
      if (revoked === null) {
        throw new AppError('NOT_FOUND', 'No such device.');
      }

      await writeAudit(context, {
        action: 'DEVICE_REVOKED',
        targetUserId: auth.userId,
        metadata: { platform: revoked.platform },
      });

      const response: RevokeDeviceResponse = {
        deviceId: revoked.deviceId,
        status: 'REVOKED',
        revokedAt: revoked.revokedAt ?? context.now.toISOString(),
        // Queued points on a revoked device are discarded rather than uploaded:
        // consent ended at revocation, and a backlog must not outlive it.
        discardedPendingEvents: true,
      };
      return { statusCode: 200, body: response };
    },
  }),
];
