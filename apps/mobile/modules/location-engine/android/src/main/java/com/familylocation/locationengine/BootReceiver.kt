package com.familylocation.locationengine

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Re-arms passive tracking after a reboot or an app update.
 *
 * Deliberately conservative: this only restores tracking that the user had
 * already consented to and that the OS still permits. It never starts
 * collecting for a user who paused sharing, and it never starts a live session
 * — a live session requires a fresh, explicit request.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) {
            return
        }

        val preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val wasSharing = preferences.getBoolean(KEY_SHARING_ENABLED, false)
        if (!wasSharing) return

        val permissions = PermissionMonitor(context)
        if (!permissions.canCollectInBackground()) return

        LocationEngine.getOrCreate(context).restoreAfterBoot()
    }

    companion object {
        const val PREFS = "com.familylocation.locationengine.prefs"
        const val KEY_SHARING_ENABLED = "sharingEnabled"
    }
}
