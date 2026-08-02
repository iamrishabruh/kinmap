package com.familylocation.locationengine

import android.content.Context
import androidx.security.crypto.EncryptedFile
import androidx.security.crypto.MasterKey
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/**
 * Encrypted, ordered, on-disk queue of pending location events (spec §11).
 *
 * Backed by an EncryptedFile whose master key lives in the Android Keystore, so
 * the coordinates are unreadable without the device. Ordering is guaranteed by
 * a monotonic sequence number persisted with the queue, and retention is capped
 * so an offline phone cannot grow the file without bound.
 *
 * Nothing in this class logs a coordinate.
 */
class EncryptedEventQueue(context: Context) {

    data class Record(
        val eventId: String,
        val sequenceNumber: Long,
        val latitude: Double,
        val longitude: Double,
        val horizontalAccuracy: Double,
        val altitude: Double?,
        val speed: Double?,
        val heading: Double?,
        val batteryLevel: Double?,
        val isLowPowerMode: Boolean,
        val trackingMode: String,
        val capturedAtMillis: Long,
        val createdAtMillis: Long,
    )

    // The application context is held rather than the passed-in one so this
    // queue can outlive an Activity without leaking it.
    private val appContext: Context = context.applicationContext
    private val lock = Any()
    private val file = File(context.filesDir, "location-engine/queue.enc")
    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private var records: MutableList<Record> = mutableListOf()
    private var nextSequence: Long = 0
    private var droppedCount: Long = 0

    init {
        file.parentFile?.mkdirs()
        load()
    }

    val size: Int get() = synchronized(lock) { records.size }

    val oldestCapturedAtMillis: Long? get() = synchronized(lock) { records.firstOrNull()?.capturedAtMillis }

    val dropped: Long get() = synchronized(lock) { droppedCount }

    fun nextSequenceNumber(): Long = synchronized(lock) {
        val value = nextSequence
        nextSequence += 1
        persist()
        value
    }

    fun enqueue(record: Record) = synchronized(lock) {
        records.add(record)
        records.sortBy { it.sequenceNumber }
        trim()
        persist()
    }

    /** Oldest-first batch; records stay until explicitly confirmed. */
    fun peek(limit: Int): List<Record> = synchronized(lock) {
        records.take(limit.coerceAtLeast(0))
    }

    fun remove(eventIds: Set<String>) = synchronized(lock) {
        records.removeAll { it.eventId in eventIds }
        persist()
    }

    fun clear() = synchronized(lock) {
        records.clear()
        persist()
    }

    private fun trim() {
        val cutoff = System.currentTimeMillis() - MAX_AGE_MILLIS
        val beforeAge = records.size
        records.removeAll { it.capturedAtMillis < cutoff }
        var dropped = beforeAge - records.size

        if (records.size > MAX_RECORDS) {
            // Oldest first: the newest fix is what the family map shows, so a
            // recent position is worth more than a stale one.
            val excess = records.size - MAX_RECORDS
            repeat(excess) { records.removeAt(0) }
            dropped += excess
        }
        droppedCount += dropped
    }

    // MARK: - Persistence

    // Re-created per call: an EncryptedFile handle is not reusable across a
    // read and a write. Argument order is (Context, File, MasterKey, scheme) —
    // security-crypto 1.1.x reversed the first two from the 1.0.x signature.
    private fun encryptedFile(): EncryptedFile = EncryptedFile.Builder(
        appContext,
        file,
        masterKey,
        EncryptedFile.FileEncryptionScheme.AES256_GCM_HKDF_4KB,
    ).build()

    private fun persist() {
        runCatching {
            if (file.exists()) file.delete()
            encryptedFile().openFileOutput().use { stream ->
                stream.write(toJson().toString().toByteArray())
            }
        }
    }

    private fun load() {
        if (!file.exists()) return
        runCatching {
            encryptedFile().openFileInput().use { stream ->
                fromJson(JSONObject(String(stream.readBytes())))
            }
        }.onFailure {
            // An unreadable queue is unrecoverable — most likely the keystore
            // entry was invalidated. Start clean rather than crash on launch.
            file.delete()
            records = mutableListOf()
        }
    }

    private fun toJson(): JSONObject {
        val array = JSONArray()
        records.forEach { record ->
            array.put(
                JSONObject().apply {
                    put("eventId", record.eventId)
                    put("sequenceNumber", record.sequenceNumber)
                    put("latitude", record.latitude)
                    put("longitude", record.longitude)
                    put("horizontalAccuracy", record.horizontalAccuracy)
                    record.altitude?.let { put("altitude", it) }
                    record.speed?.let { put("speed", it) }
                    record.heading?.let { put("heading", it) }
                    record.batteryLevel?.let { put("batteryLevel", it) }
                    put("isLowPowerMode", record.isLowPowerMode)
                    put("trackingMode", record.trackingMode)
                    put("capturedAtMillis", record.capturedAtMillis)
                    put("createdAtMillis", record.createdAtMillis)
                },
            )
        }
        return JSONObject().apply {
            put("nextSequence", nextSequence)
            put("droppedCount", droppedCount)
            put("records", array)
        }
    }

    private fun fromJson(json: JSONObject) {
        nextSequence = json.optLong("nextSequence", 0)
        droppedCount = json.optLong("droppedCount", 0)
        val array = json.optJSONArray("records") ?: JSONArray()
        val loaded = mutableListOf<Record>()
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            loaded.add(
                Record(
                    eventId = item.optString("eventId"),
                    sequenceNumber = item.optLong("sequenceNumber"),
                    latitude = item.optDouble("latitude"),
                    longitude = item.optDouble("longitude"),
                    horizontalAccuracy = item.optDouble("horizontalAccuracy"),
                    altitude = if (item.has("altitude")) item.optDouble("altitude") else null,
                    speed = if (item.has("speed")) item.optDouble("speed") else null,
                    heading = if (item.has("heading")) item.optDouble("heading") else null,
                    batteryLevel = if (item.has("batteryLevel")) item.optDouble("batteryLevel") else null,
                    isLowPowerMode = item.optBoolean("isLowPowerMode"),
                    trackingMode = item.optString("trackingMode"),
                    capturedAtMillis = item.optLong("capturedAtMillis"),
                    createdAtMillis = item.optLong("createdAtMillis"),
                ),
            )
        }
        records = loaded.sortedBy { it.sequenceNumber }.toMutableList()
    }

    companion object {
        const val MAX_RECORDS = 5_000
        const val MAX_AGE_MILLIS = 72L * 60 * 60 * 1000
    }
}
