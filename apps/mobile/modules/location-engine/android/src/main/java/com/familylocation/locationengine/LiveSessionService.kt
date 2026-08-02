package com.familylocation.locationengine

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat

/**
 * Foreground service backing a live session.
 *
 * This service exists for exactly one reason: while a family member is watching
 * someone's live position, the platform requires — and this product wants — a
 * persistent, visible notification saying so. The notification is never hidden,
 * never made low-priority to escape the shade, and never worded ambiguously.
 * Making live tracking invisible would turn this into the stalkerware the whole
 * design exists to avoid (spec §9, §34).
 *
 * The service also enforces its own deadline, so a session ends on time even if
 * the device is offline when the server expires it.
 */
class LiveSessionService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private var stopRunnable: Runnable? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val sessionId = intent?.getStringExtra(EXTRA_SESSION_ID) ?: return stopImmediately()
        val durationSeconds = intent.getLongExtra(EXTRA_DURATION_SECONDS, 0L)
        if (durationSeconds <= 0) return stopImmediately()

        val cappedSeconds = durationSeconds.coerceAtMost(MAX_SESSION_SECONDS)

        createChannel()
        val notification = buildNotification(cappedSeconds)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        // Hard local deadline, independent of the server.
        stopRunnable?.let(handler::removeCallbacks)
        val runnable = Runnable {
            LocationEngine.instance?.onLiveSessionExpired(sessionId)
            stopSelf()
        }
        stopRunnable = runnable
        handler.postDelayed(runnable, cappedSeconds * 1_000)

        // NOT_STICKY: if the process dies the session is over. Silently
        // resurrecting live tracking without the user asking would be exactly
        // the covert behaviour this product forbids.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stopRunnable?.let(handler::removeCallbacks)
        stopRunnable = null
        super.onDestroy()
    }

    private fun stopImmediately(): Int {
        stopSelf()
        return START_NOT_STICKY
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return

        val channel = NotificationChannel(
            CHANNEL_ID,
            "Live location sharing",
            // DEFAULT, not MIN: the person being located must be able to see
            // this without hunting for it.
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = "Shown whenever you are sharing your live location with your family."
            setShowBadge(true)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(durationSeconds: Long): Notification {
        val minutes = (durationSeconds / 60).coerceAtLeast(1)
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Sharing your live location")
            .setContentText("Your family can see where you are for the next $minutes minutes.")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
    }

    companion object {
        const val EXTRA_SESSION_ID = "sessionId"
        const val EXTRA_DURATION_SECONDS = "durationSeconds"
        private const val CHANNEL_ID = "live-location-sharing"
        private const val NOTIFICATION_ID = 4711

        /** Matches LIMITS.MAX_LIVE_SESSION_SECONDS in @family/contracts. */
        const val MAX_SESSION_SECONDS = 600L

        fun start(context: Context, sessionId: String, durationSeconds: Long) {
            val intent = Intent(context, LiveSessionService::class.java).apply {
                putExtra(EXTRA_SESSION_ID, sessionId)
                putExtra(EXTRA_DURATION_SECONDS, durationSeconds)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, LiveSessionService::class.java))
        }
    }
}
