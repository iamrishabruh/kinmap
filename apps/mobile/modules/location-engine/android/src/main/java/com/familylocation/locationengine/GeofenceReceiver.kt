package com.familylocation.locationengine

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingEvent

/**
 * Receives geofence transitions and forwards them as opaque events.
 *
 * The payload carries a place id and a direction — never the coordinate of the
 * place or of the device (spec §20, §22).
 */
class GeofenceReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val event = GeofencingEvent.fromIntent(intent) ?: return
        if (event.hasError()) {
            // Error codes only; the event carries no location to leak.
            LocationEngine.instance?.reportGeofenceError(event.errorCode)
            return
        }

        val transition = when (event.geofenceTransition) {
            Geofence.GEOFENCE_TRANSITION_ENTER -> "ARRIVAL"
            Geofence.GEOFENCE_TRANSITION_EXIT -> "DEPARTURE"
            // DWELL is not used: arrival and departure are the only transitions
            // the product exposes, and mapping DWELL onto either would produce
            // a duplicate notification.
            else -> return
        }

        val occurredAt = System.currentTimeMillis()
        event.triggeringGeofences?.forEach { geofence ->
            LocationEngine.instance?.emitGeofenceTransition(
                placeId = geofence.requestId,
                transition = transition,
                occurredAtMillis = occurredAt,
            )
        }
    }
}
