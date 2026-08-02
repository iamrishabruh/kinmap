package com.familylocation.locationengine

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager

/** Battery and charging state, used to drive the low/critical battery states. */
class DeviceHealth(context: Context) {
    private val appContext = context.applicationContext

    /** 0.0–1.0, or null when the platform will not report it. */
    fun batteryLevel(): Double? {
        val manager = appContext.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
        val capacity = manager?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: return null
        return if (capacity in 0..100) capacity / 100.0 else null
    }

    fun isCharging(): Boolean? {
        val intent = appContext.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            ?: return null
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        return status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL
    }
}
