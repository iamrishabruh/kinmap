package com.familylocation.locationengine

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.location.Location
import android.os.Build
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingClient
import com.google.android.gms.location.GeofencingRequest
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import java.util.UUID

/**
 * The Android background-location engine (spec §9).
 *
 * Strategy, and why:
 *
 *  - **Fused Location Provider with a state-dependent priority.** Balanced
 *    power is the default; high accuracy is reserved for live sessions.
 *  - **Geofencing API** for arrival and departure at saved places. It is far
 *    cheaper than polling and keeps working while the app is not running.
 *  - **A foreground service only for live sessions**, with a visible
 *    notification the user cannot miss.
 *  - **WorkManager** for uploads, so a batch survives process death and waits
 *    for connectivity instead of burning the radio while offline.
 *
 * No promise is made about update frequency. Doze, App Standby and OEM battery
 * managers can all defer delivery, and the product copy says so rather than
 * claiming an interval the platform will not honour.
 */
class LocationEngine private constructor(context: Context) {

    private val appContext = context.applicationContext
    private val fusedClient = LocationServices.getFusedLocationProviderClient(appContext)
    private val geofencingClient: GeofencingClient = LocationServices.getGeofencingClient(appContext)
    private val permissions = PermissionMonitor(appContext)
    private val deviceHealth = DeviceHealth(appContext)
    private val queue = EncryptedEventQueue(appContext)

    private var configuration = EngineConfiguration()
    private var state: TrackingState = TrackingState.DISABLED
    private var sharingPaused = false
    private var lastAccepted: Location? = null
    private var activeLiveSessionId: String? = null
    private var registeredPlaceIds = mutableSetOf<String>()

    /** Set by the Expo module so the engine can push events to JavaScript. */
    var eventSink: ((String, Map<String, Any?>) -> Unit)? = null

    private val locationCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            result.locations.forEach(::accept)
        }
    }

    // MARK: - Configuration and lifecycle

    fun configure(config: EngineConfiguration) {
        configuration = config
        emitState("configured")
    }

    @SuppressLint("MissingPermission")
    fun startPassiveTracking() {
        check(!sharingPaused) { "Sharing is paused; resume it explicitly before tracking." }
        check(permissions.hasFineLocation() || permissions.hasCoarseLocation()) {
            "Location permission has not been granted."
        }

        transition(batteryAdjustedAmbientState(), "passive-started")
        requestUpdates(state)
        setSharingPersisted(true)
    }

    fun pauseSharing() {
        sharingPaused = true
        stopLiveSession()
        fusedClient.removeLocationUpdates(locationCallback)
        unregisterAllGeofences()
        // A user who pauses expects nothing further to reach their family, so
        // anything captured but not yet uploaded is discarded.
        queue.clear()
        setSharingPersisted(false)
        transition(TrackingState.DISABLED, "sharing-paused")
    }

    fun resumeSharing() {
        sharingPaused = false
        startPassiveTracking()
        emitState("sharing-resumed")
    }

    fun restoreAfterBoot() {
        if (sharingPaused || !permissions.canCollectInBackground()) return
        runCatching { startPassiveTracking() }
    }

    // MARK: - Live sessions

    fun startLiveSession(sessionId: String, durationSeconds: Long) {
        check(!sharingPaused) { "Sharing is paused." }
        val battery = deviceHealth.batteryLevel()
        // Refusing on a nearly-dead battery keeps the device alive long enough
        // to report its last known position, which matters more.
        check(battery == null || battery > configuration.criticalBatteryThreshold) {
            "Battery is too low to start a live session."
        }

        activeLiveSessionId = sessionId
        val capped = durationSeconds.coerceAtMost(configuration.liveSessionMaxSeconds.toLong())
        LiveSessionService.start(appContext, sessionId, capped)
        transition(TrackingState.LIVE, "live-session-started")
        requestUpdates(TrackingState.LIVE)
    }

    fun stopLiveSession() {
        if (activeLiveSessionId == null) return
        activeLiveSessionId = null
        LiveSessionService.stop(appContext)
        transition(batteryAdjustedAmbientState(), "live-session-stopped")
        requestUpdates(state)
    }

    fun onLiveSessionExpired(sessionId: String) {
        if (activeLiveSessionId != sessionId) return
        activeLiveSessionId = null
        transition(batteryAdjustedAmbientState(), "live-session-expired")
        requestUpdates(state)
    }

    // MARK: - Geofences

    @SuppressLint("MissingPermission")
    fun registerGeofences(places: List<Map<String, Any?>>) {
        if (sharingPaused || !permissions.canCollectInBackground()) return

        val geofences = places.mapNotNull { place ->
            val placeId = place["placeId"] as? String ?: return@mapNotNull null
            val latitude = (place["latitude"] as? Number)?.toDouble() ?: return@mapNotNull null
            val longitude = (place["longitude"] as? Number)?.toDouble() ?: return@mapNotNull null
            val radius = (place["radiusMeters"] as? Number)?.toFloat() ?: return@mapNotNull null

            var transitions = 0
            if (place["notifyOnArrival"] as? Boolean != false) {
                transitions = transitions or Geofence.GEOFENCE_TRANSITION_ENTER
            }
            if (place["notifyOnDeparture"] as? Boolean != false) {
                transitions = transitions or Geofence.GEOFENCE_TRANSITION_EXIT
            }
            if (transitions == 0) return@mapNotNull null

            registeredPlaceIds.add(placeId)
            Geofence.Builder()
                .setRequestId(placeId)
                .setCircularRegion(latitude, longitude, radius)
                .setExpirationDuration(Geofence.NEVER_EXPIRE)
                .setTransitionTypes(transitions)
                // Suppresses the burst of transitions a fresh registration would
                // otherwise emit for places the user is already inside.
                .setNotificationResponsiveness(NOTIFICATION_RESPONSIVENESS_MS)
                .build()
        }

        if (geofences.isEmpty()) return

        val request = GeofencingRequest.Builder()
            .setInitialTrigger(0)
            .addGeofences(geofences)
            .build()

        geofencingClient.addGeofences(request, geofencePendingIntent())
    }

    fun unregisterGeofences(placeIds: List<String>) {
        if (placeIds.isEmpty()) return
        registeredPlaceIds.removeAll(placeIds.toSet())
        geofencingClient.removeGeofences(placeIds)
    }

    private fun unregisterAllGeofences() {
        if (registeredPlaceIds.isEmpty()) return
        geofencingClient.removeGeofences(registeredPlaceIds.toList())
        registeredPlaceIds.clear()
    }

    private fun geofencePendingIntent(): PendingIntent {
        val intent = Intent(appContext, GeofenceReceiver::class.java)
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            flags = flags or PendingIntent.FLAG_MUTABLE
        }
        return PendingIntent.getBroadcast(appContext, 0, intent, flags)
    }

    // MARK: - Reporting

    fun permissionState(): Map<String, Any?> = permissions.snapshot()

    fun health(): Map<String, Any?> = mapOf(
        "permission" to permissions.snapshot(),
        "trackingState" to state.wireName,
        "batteryLevel" to deviceHealth.batteryLevel(),
        "isLowPowerMode" to permissions.isPowerSaveMode(),
        "isCharging" to deviceHealth.isCharging(),
        "pendingEventCount" to queue.size,
        "oldestPendingEventAt" to queue.oldestCapturedAtMillis?.let(::iso8601),
        "lastAcceptedAt" to lastAccepted?.time?.let(::iso8601),
        "lastUploadAttemptAt" to null,
        "lastUploadError" to null,
        "remoteConfigVersion" to configuration.configVersion,
    )

    /** Hands the pending batch to JavaScript, which owns the HTTP call. */
    fun pendingBatch(): Map<String, Any?> {
        val batch = queue.peek(configuration.uploadBatchSize)
        return mapOf(
            "uploadedCount" to 0,
            "remainingCount" to queue.size,
            "lastError" to null,
            "attemptedAt" to iso8601(System.currentTimeMillis()),
            "pending" to batch.map { record ->
                mapOf(
                    "eventId" to record.eventId,
                    "sequenceNumber" to record.sequenceNumber,
                    "latitude" to record.latitude,
                    "longitude" to record.longitude,
                    "horizontalAccuracy" to record.horizontalAccuracy,
                    "altitude" to record.altitude,
                    "speed" to record.speed,
                    "heading" to record.heading,
                    "batteryLevel" to record.batteryLevel,
                    "isLowPowerMode" to record.isLowPowerMode,
                    "trackingMode" to record.trackingMode,
                    "capturedAt" to iso8601(record.capturedAtMillis),
                    "createdAt" to iso8601(record.createdAtMillis),
                )
            },
        )
    }

    fun confirmUploaded(eventIds: List<String>) {
        queue.remove(eventIds.toSet())
        emitQueueChange()
    }

    fun emitGeofenceTransition(placeId: String, transition: String, occurredAtMillis: Long) {
        if (sharingPaused) return
        eventSink?.invoke(
            "onGeofenceTransition",
            // Opaque identifier only — never the coordinate of the place.
            mapOf(
                "placeId" to placeId,
                "transition" to transition,
                "occurredAt" to iso8601(occurredAtMillis),
            ),
        )
    }

    fun reportGeofenceError(errorCode: Int) {
        eventSink?.invoke("onEngineStateChange", mapOf("state" to state.wireName, "reason" to "geofence-error-$errorCode"))
    }

    // MARK: - Internals

    @SuppressLint("MissingPermission")
    private fun requestUpdates(target: TrackingState) {
        fusedClient.removeLocationUpdates(locationCallback)
        if (!target.producesLocation) return

        val request = LocationRequest.Builder(target.priority, target.intervalMillis)
            .setMinUpdateDistanceMeters(configuration.distanceFilterFor(target))
            // Never wake the device more often than the ambient interval, even
            // if another app has a faster request running.
            .setMinUpdateIntervalMillis(target.intervalMillis)
            .setWaitForAccurateLocation(target == TrackingState.LIVE)
            .build()

        fusedClient.requestLocationUpdates(request, locationCallback, appContext.mainLooper)
    }

    private fun batteryAdjustedAmbientState(): TrackingState {
        if (sharingPaused) return TrackingState.DISABLED
        val level = deviceHealth.batteryLevel()
        if (level != null) {
            if (level <= configuration.criticalBatteryThreshold) return TrackingState.CRITICAL_BATTERY
            if (level <= configuration.lowBatteryThreshold) return TrackingState.LOW_BATTERY
        }
        if (permissions.isPowerSaveMode()) return TrackingState.LOW_BATTERY
        return TrackingState.PASSIVE
    }

    private fun transition(next: TrackingState, reason: String) {
        if (next == state) return
        state = next
        emitState(reason)
    }

    private fun emitState(reason: String) {
        eventSink?.invoke("onEngineStateChange", mapOf("state" to state.wireName, "reason" to reason))
    }

    private fun emitQueueChange() {
        eventSink?.invoke("onQueueChange", mapOf("pendingEventCount" to queue.size))
    }

    /**
     * Acceptance gate. A fix failing any of these is dropped on the device
     * rather than uploaded and rejected — that saves radio, battery and backend
     * cost, and keeps obviously-wrong points off the family map.
     *
     * No branch here logs a coordinate.
     */
    private fun accept(location: Location) {
        if (!state.producesLocation || sharingPaused) return
        if (!location.hasAccuracy() || location.accuracy < 0) return
        if (location.accuracy > configuration.maxAcceptableAccuracyMeters) return

        val ageMillis = System.currentTimeMillis() - location.time
        if (ageMillis > EncryptedEventQueue.MAX_AGE_MILLIS || ageMillis < -120_000) return

        lastAccepted?.let { previous ->
            val distance = location.distanceTo(previous)
            val elapsedSeconds = (location.time - previous.time) / 1000.0
            // Duplicate: same place, same moment.
            if (distance < 20f && elapsedSeconds < 60) return
            // Implausible ground speed implies a spoofed or corrupt fix.
            if (elapsedSeconds > 0 && distance / elapsedSeconds > 350) return
            if (state == TrackingState.STATIONARY &&
                distance < configuration.distanceFilterFor(TrackingState.STATIONARY)
            ) {
                return
            }
        }

        lastAccepted = location

        queue.enqueue(
            EncryptedEventQueue.Record(
                eventId = UUID.randomUUID().toString(),
                sequenceNumber = queue.nextSequenceNumber(),
                latitude = location.latitude,
                longitude = location.longitude,
                horizontalAccuracy = location.accuracy.toDouble(),
                altitude = if (location.hasAltitude()) location.altitude else null,
                speed = if (location.hasSpeed()) location.speed.toDouble() else null,
                heading = if (location.hasBearing()) location.bearing.toDouble() else null,
                batteryLevel = deviceHealth.batteryLevel(),
                isLowPowerMode = permissions.isPowerSaveMode(),
                trackingMode = state.wireName,
                capturedAtMillis = location.time,
                createdAtMillis = System.currentTimeMillis(),
            ),
        )
        emitQueueChange()
    }

    private fun setSharingPersisted(enabled: Boolean) {
        appContext.getSharedPreferences(BootReceiver.PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(BootReceiver.KEY_SHARING_ENABLED, enabled)
            .apply()
    }

    private fun iso8601(millis: Long): String =
        java.time.Instant.ofEpochMilli(millis).toString()

    companion object {
        private const val NOTIFICATION_RESPONSIVENESS_MS = 5 * 60 * 1000

        @Volatile
        var instance: LocationEngine? = null
            private set

        fun getOrCreate(context: Context): LocationEngine =
            instance ?: synchronized(this) {
                instance ?: LocationEngine(context).also { instance = it }
            }
    }
}
