package com.familylocation.locationengine

/**
 * Engine tuning delivered by signed remote configuration.
 *
 * Clamped here, in native code, to the same guardrails the TypeScript layer
 * enforces (spec §30). This is the last clamp before the values reach the Fused
 * Location Provider, so a bug or a hostile config upstream still cannot make
 * the device poll GPS continuously or extend a live session past its ceiling.
 */
data class EngineConfiguration(
    val configVersion: Int = 0,
    val distanceFilters: Map<String, Double> = emptyMap(),
    val targetFreshnessSeconds: Map<String, Double> = emptyMap(),
    val maxStaleSeconds: Double = 1_800.0,
    val liveSessionMaxSeconds: Double = 600.0,
    val liveSessionUpdateIntervalSeconds: Double = 15.0,
    val lowBatteryThreshold: Double = 0.2,
    val criticalBatteryThreshold: Double = 0.1,
    val uploadBatchSize: Int = 50,
    val minUploadIntervalSeconds: Double = 30.0,
    val maxAcceptableAccuracyMeters: Double = 500.0,
) {
    fun distanceFilterFor(state: TrackingState): Float =
        distanceFilters[state.wireName]
            ?.let { clamp(it, DISTANCE_FILTER).toFloat() }
            ?: state.defaultDistanceFilterMeters

    companion object {
        // Mirrors CONFIG_GUARDRAILS in @family/contracts.
        private val DISTANCE_FILTER = 10.0..5_000.0
        private val FRESHNESS = 10.0..3_600.0
        private val STALE = 300.0..86_400.0
        private val LIVE_DURATION = 60.0..600.0
        private val LIVE_INTERVAL = 10.0..30.0
        private val LOW_BATTERY = 0.05..0.5
        private val CRITICAL_BATTERY = 0.02..0.2
        private val BATCH_SIZE = 1.0..100.0
        private val UPLOAD_INTERVAL = 30.0..3_600.0
        private val ACCURACY = 5.0..500.0

        private fun clamp(value: Double, range: ClosedFloatingPointRange<Double>): Double =
            if (value.isNaN() || value.isInfinite()) range.start
            else value.coerceIn(range.start, range.endInclusive)

        @Suppress("UNCHECKED_CAST")
        fun fromMap(map: Map<String, Any?>): EngineConfiguration {
            val defaults = EngineConfiguration()

            fun number(key: String, fallback: Double, range: ClosedFloatingPointRange<Double>): Double {
                val raw = (map[key] as? Number)?.toDouble() ?: fallback
                return clamp(raw, range)
            }

            val low = number("lowBatteryThreshold", defaults.lowBatteryThreshold, LOW_BATTERY)
            var critical =
                number("criticalBatteryThreshold", defaults.criticalBatteryThreshold, CRITICAL_BATTERY)
            // An inverted pair would flip the engine between LOW and CRITICAL on
            // every battery reading, so the invariant is restored, not trusted.
            if (critical >= low) critical = minOf(0.1, low / 2)

            val filters = (map["distanceFilters"] as? Map<String, Any?>).orEmpty()
                .mapNotNull { (k, v) ->
                    (v as? Number)?.let { k to clamp(it.toDouble(), DISTANCE_FILTER) }
                }
                .toMap()

            val freshness = (map["targetFreshnessSeconds"] as? Map<String, Any?>).orEmpty()
                .mapNotNull { (k, v) -> (v as? Number)?.let { k to clamp(it.toDouble(), FRESHNESS) } }
                .toMap()

            return EngineConfiguration(
                configVersion = ((map["configVersion"] as? Number)?.toInt() ?: 0).coerceAtLeast(0),
                distanceFilters = filters,
                targetFreshnessSeconds = freshness,
                maxStaleSeconds = number("maxStaleSeconds", defaults.maxStaleSeconds, STALE),
                liveSessionMaxSeconds =
                    number("liveSessionMaxSeconds", defaults.liveSessionMaxSeconds, LIVE_DURATION),
                liveSessionUpdateIntervalSeconds = number(
                    "liveSessionUpdateIntervalSeconds",
                    defaults.liveSessionUpdateIntervalSeconds,
                    LIVE_INTERVAL,
                ),
                lowBatteryThreshold = low,
                criticalBatteryThreshold = critical,
                uploadBatchSize =
                    number("uploadBatchSize", defaults.uploadBatchSize.toDouble(), BATCH_SIZE).toInt(),
                minUploadIntervalSeconds = number(
                    "minUploadIntervalSeconds",
                    defaults.minUploadIntervalSeconds,
                    UPLOAD_INTERVAL,
                ),
                maxAcceptableAccuracyMeters = number(
                    "maxAcceptableAccuracyMeters",
                    defaults.maxAcceptableAccuracyMeters,
                    ACCURACY,
                ),
            )
        }
    }
}
