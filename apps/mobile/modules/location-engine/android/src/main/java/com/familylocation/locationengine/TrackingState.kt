package com.familylocation.locationengine

import com.google.android.gms.location.Priority

/**
 * The subset of the shared state machine the native layer needs. The
 * authoritative reducer lives in @family/location-core; Android only needs to
 * know which Fused Location posture each state implies.
 */
enum class TrackingState(val wireName: String) {
    DISABLED("DISABLED"),
    PERMISSION_REQUIRED("PERMISSION_REQUIRED"),
    STATIONARY("STATIONARY"),
    PASSIVE("PASSIVE"),
    WALKING("WALKING"),
    TRANSIT("TRANSIT"),
    LIVE("LIVE"),
    LOW_BATTERY("LOW_BATTERY"),
    CRITICAL_BATTERY("CRITICAL_BATTERY"),
    OFFLINE("OFFLINE"),
    STALE("STALE");

    /** Whether this state may store and upload a coordinate at all. */
    val producesLocation: Boolean
        get() = this != DISABLED && this != PERMISSION_REQUIRED

    /**
     * High accuracy is only ever justified during a live session, which the
     * located person has agreed to and can see. Everything else uses balanced
     * power or lower so the app is not a battery story in reviews.
     */
    val priority: Int
        get() = when (this) {
            LIVE -> Priority.PRIORITY_HIGH_ACCURACY
            TRANSIT -> Priority.PRIORITY_BALANCED_POWER_ACCURACY
            WALKING, PASSIVE -> Priority.PRIORITY_BALANCED_POWER_ACCURACY
            STATIONARY, STALE, OFFLINE -> Priority.PRIORITY_LOW_POWER
            LOW_BATTERY, CRITICAL_BATTERY -> Priority.PRIORITY_LOW_POWER
            DISABLED, PERMISSION_REQUIRED -> Priority.PRIORITY_PASSIVE
        }

    /** Target interval in milliseconds. Best effort — never a guarantee. */
    val intervalMillis: Long
        get() = when (this) {
            LIVE -> 15_000L
            TRANSIT -> 3 * 60_000L
            WALKING -> 5 * 60_000L
            PASSIVE -> 10 * 60_000L
            STATIONARY -> 45 * 60_000L
            LOW_BATTERY -> 60 * 60_000L
            CRITICAL_BATTERY -> 3 * 60 * 60_000L
            OFFLINE, STALE -> 10 * 60_000L
            DISABLED, PERMISSION_REQUIRED -> Long.MAX_VALUE
        }

    val defaultDistanceFilterMeters: Float
        get() = when (this) {
            LIVE -> 10f
            TRANSIT -> 100f
            WALKING -> 50f
            PASSIVE -> 150f
            STATIONARY -> 500f
            LOW_BATTERY, CRITICAL_BATTERY -> 1_000f
            OFFLINE, STALE -> 150f
            DISABLED, PERMISSION_REQUIRED -> 5_000f
        }

    companion object {
        fun fromWireName(value: String?): TrackingState =
            entries.firstOrNull { it.wireName == value } ?: DISABLED
    }
}
