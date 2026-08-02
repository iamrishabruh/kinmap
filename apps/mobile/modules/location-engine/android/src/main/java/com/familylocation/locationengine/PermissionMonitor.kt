package com.familylocation.locationengine

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.os.PowerManager
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * Reports the honest, complete permission picture (spec §9).
 *
 * Android has more ways to silently break background location than iOS does —
 * coarse-only grants, a missing background grant, notification permission,
 * doze, and OEM battery managers that ignore all of the above. The
 * troubleshooting screen can only help a user if this reports every one of them
 * separately rather than collapsing them into a single boolean.
 */
class PermissionMonitor(private val context: Context) {

    fun snapshot(): Map<String, Any?> = mapOf(
        "authorization" to authorization(),
        "preciseLocationEnabled" to hasFineLocation(),
        "locationServicesEnabled" to locationServicesEnabled(),
        "notificationsEnabled" to notificationsEnabled(),
        // On Android the closest analogue of Background App Refresh is the
        // background-location grant itself.
        "backgroundRefreshEnabled" to hasBackgroundLocation(),
        "foregroundServicePermissionGranted" to hasForegroundServiceLocation(),
        "batteryOptimizationIgnored" to isIgnoringBatteryOptimizations(),
    )

    /**
     * Mapped onto the shared LocationAuthorization vocabulary so the UI does not
     * need platform-specific branches.
     */
    private fun authorization(): String = when {
        hasBackgroundLocation() && (hasFineLocation() || hasCoarseLocation()) -> "ALWAYS"
        hasFineLocation() || hasCoarseLocation() -> "WHEN_IN_USE"
        // Android gives no "not determined" signal after the first denial, so a
        // missing grant is reported as DENIED and the UI offers Settings.
        else -> "DENIED"
    }

    fun hasFineLocation(): Boolean = granted(Manifest.permission.ACCESS_FINE_LOCATION)

    fun hasCoarseLocation(): Boolean = granted(Manifest.permission.ACCESS_COARSE_LOCATION)

    fun hasBackgroundLocation(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            granted(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        } else {
            // Before Android 10 the foreground grant covered background use.
            hasFineLocation() || hasCoarseLocation()
        }

    private fun hasForegroundServiceLocation(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            granted("android.permission.FOREGROUND_SERVICE_LOCATION")
        } else {
            true
        }

    private fun notificationsEnabled(): Boolean =
        NotificationManagerCompat.from(context).areNotificationsEnabled()

    private fun locationServicesEnabled(): Boolean {
        val manager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
            ?: return false
        return manager.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
            manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
    }

    /**
     * The single most common cause of "it stopped updating overnight" reports.
     * Surfaced so the troubleshooting screen can name it instead of guessing.
     */
    private fun isIgnoringBatteryOptimizations(): Boolean {
        val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
        return power.isIgnoringBatteryOptimizations(context.packageName)
    }

    fun isPowerSaveMode(): Boolean {
        val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
        return power.isPowerSaveMode
    }

    /**
     * True when the engine may collect at all. Background collection needs the
     * background grant; foreground-only still works while the app is open.
     */
    fun canCollectInBackground(): Boolean =
        (hasFineLocation() || hasCoarseLocation()) && hasBackgroundLocation()

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
}
