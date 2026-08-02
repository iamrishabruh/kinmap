import CoreLocation
import Foundation

/**
 * Engine tuning delivered by signed remote configuration.
 *
 * Every value is clamped here, in native code, to the same guardrails the
 * TypeScript layer enforces (spec §30). This is the last clamp before the
 * values reach Core Location, so a bug or a hostile config upstream still
 * cannot make the device poll GPS continuously or shorten a live session's
 * visibility.
 */
struct EngineConfiguration {
    struct Range {
        let min: Double
        let max: Double
        func clamp(_ value: Double) -> Double {
            guard value.isFinite else { return self.min }
            return Swift.min(self.max, Swift.max(self.min, value))
        }
    }

    // Mirrors CONFIG_GUARDRAILS in @family/contracts.
    static let distanceFilterRange = Range(min: 10, max: 5000)
    static let freshnessRange = Range(min: 10, max: 3600)
    static let staleRange = Range(min: 300, max: 86400)
    static let liveDurationRange = Range(min: 60, max: 600)
    static let liveIntervalRange = Range(min: 10, max: 30)
    static let lowBatteryRange = Range(min: 0.05, max: 0.5)
    static let criticalBatteryRange = Range(min: 0.02, max: 0.2)
    static let batchSizeRange = Range(min: 1, max: 100)
    static let uploadIntervalRange = Range(min: 30, max: 3600)
    static let accuracyRange = Range(min: 5, max: 500)

    var configVersion: Int = 0
    var distanceFilters: [String: Double] = [:]
    var targetFreshnessSeconds: [String: Double] = [:]
    var maxStaleSeconds: Double = 1800
    var liveSessionMaxSeconds: Double = 600
    var liveSessionUpdateIntervalSeconds: Double = 15
    var lowBatteryThreshold: Double = 0.2
    var criticalBatteryThreshold: Double = 0.1
    var uploadBatchSize: Int = 50
    var minUploadIntervalSeconds: Double = 30
    var maxAcceptableAccuracyMeters: Double = 500

    init() {}

    init(dictionary: [String: Any]) {
        configVersion = max(0, dictionary["configVersion"] as? Int ?? 0)

        if let filters = dictionary["distanceFilters"] as? [String: Double] {
            distanceFilters = filters.mapValues(Self.distanceFilterRange.clamp)
        }
        if let freshness = dictionary["targetFreshnessSeconds"] as? [String: Double] {
            targetFreshnessSeconds = freshness.mapValues(Self.freshnessRange.clamp)
        }

        maxStaleSeconds = Self.staleRange.clamp(dictionary["maxStaleSeconds"] as? Double ?? maxStaleSeconds)
        liveSessionMaxSeconds = Self.liveDurationRange.clamp(
            dictionary["liveSessionMaxSeconds"] as? Double ?? liveSessionMaxSeconds
        )
        liveSessionUpdateIntervalSeconds = Self.liveIntervalRange.clamp(
            dictionary["liveSessionUpdateIntervalSeconds"] as? Double ?? liveSessionUpdateIntervalSeconds
        )
        lowBatteryThreshold = Self.lowBatteryRange.clamp(
            dictionary["lowBatteryThreshold"] as? Double ?? lowBatteryThreshold
        )
        criticalBatteryThreshold = Self.criticalBatteryRange.clamp(
            dictionary["criticalBatteryThreshold"] as? Double ?? criticalBatteryThreshold
        )
        // An inverted pair would flip the engine between LOW and CRITICAL on every
        // battery reading, so the invariant is restored rather than trusted.
        if criticalBatteryThreshold >= lowBatteryThreshold {
            criticalBatteryThreshold = min(0.1, lowBatteryThreshold / 2)
        }

        uploadBatchSize = Int(Self.batchSizeRange.clamp(Double(dictionary["uploadBatchSize"] as? Int ?? uploadBatchSize)))
        minUploadIntervalSeconds = Self.uploadIntervalRange.clamp(
            dictionary["minUploadIntervalSeconds"] as? Double ?? minUploadIntervalSeconds
        )
        maxAcceptableAccuracyMeters = Self.accuracyRange.clamp(
            dictionary["maxAcceptableAccuracyMeters"] as? Double ?? maxAcceptableAccuracyMeters
        )
    }

    /// Distance filter for a tracking state, in metres, with a conservative default.
    func distanceFilter(for state: TrackingState) -> CLLocationDistance {
        distanceFilters[state.rawValue].map(Self.distanceFilterRange.clamp) ?? state.defaultDistanceFilter
    }
}

/**
 * The subset of the shared state machine the native layer needs. The
 * authoritative reducer lives in @family/location-core; iOS only needs to know
 * which Core Location posture each state implies.
 */
enum TrackingState: String {
    case disabled = "DISABLED"
    case permissionRequired = "PERMISSION_REQUIRED"
    case stationary = "STATIONARY"
    case passive = "PASSIVE"
    case walking = "WALKING"
    case transit = "TRANSIT"
    case live = "LIVE"
    case lowBattery = "LOW_BATTERY"
    case criticalBattery = "CRITICAL_BATTERY"
    case offline = "OFFLINE"
    case stale = "STALE"

    /// Whether this state may store and upload a coordinate at all.
    var producesLocation: Bool {
        switch self {
        case .disabled, .permissionRequired:
            false
        default:
            true
        }
    }

    /// Continuous, navigation-grade GPS is only ever justified during a live
    /// session. Everything else rides significant-change and region monitoring.
    var allowsContinuousUpdates: Bool {
        self == .live
    }

    var desiredAccuracy: CLLocationAccuracy {
        switch self {
        case .live:
            kCLLocationAccuracyBest
        case .transit:
            kCLLocationAccuracyNearestTenMeters
        case .walking:
            kCLLocationAccuracyHundredMeters
        case .passive, .stationary, .stale, .offline:
            kCLLocationAccuracyHundredMeters
        case .lowBattery, .criticalBattery:
            kCLLocationAccuracyKilometer
        case .disabled, .permissionRequired:
            kCLLocationAccuracyThreeKilometers
        }
    }

    var defaultDistanceFilter: CLLocationDistance {
        switch self {
        case .live: 10
        case .transit: 100
        case .walking: 50
        case .passive: 150
        case .stationary: 500
        case .lowBattery, .criticalBattery: 1000
        case .offline, .stale: 150
        case .disabled, .permissionRequired: 5000
        }
    }
}
