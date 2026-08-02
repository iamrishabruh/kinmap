import CoreLocation
import CoreMotion
import Foundation
import UIKit

/**
 * The iOS background-location engine (spec §9).
 *
 * Strategy, and why:
 *
 *  - **Significant-change monitoring is the default.** It is the only mechanism
 *    that reliably relaunches a terminated app, and it costs almost no battery
 *    because it rides cell/Wi-Fi transitions the radio is already observing.
 *  - **Region monitoring** provides arrival and departure at saved places.
 *  - **Visit monitoring** gives high-quality "arrived somewhere and stayed"
 *    events that significant-change alone misses.
 *  - **Standard location updates run only during a live session**, and stop
 *    automatically when it expires. Navigation-grade GPS is never left running:
 *    it would flatten a phone in hours and is not needed to answer "is my
 *    family member home yet".
 *
 * This engine makes no promise about update frequency, and the API deliberately
 * exposes none. iOS decides when to deliver significant-change and visit
 * events; the honest contract is "best effort, target freshness", which is what
 * the product copy says too.
 */
final class LocationEngine: NSObject {
    static let shared = LocationEngine()

    enum LiveSessionEndReason {
        case expired
        case stoppedByUser
        case criticalBattery
        case permissionLost
    }

    /// Set by the Expo module so the engine can push events to JavaScript.
    var eventSink: ((String, [String: Any?]) -> Void)?

    private let manager = CLLocationManager()
    private let motionActivityManager = CMMotionActivityManager()
    private let queue = LocationEventQueue()

    private var configuration = EngineConfiguration()
    private var state: TrackingState = .disabled
    private var sharingPaused = false
    private var geofences: [GeofenceRegion] = []
    private var lastAcceptedLocation: CLLocation?
    private var lastUploadAttemptAt: Date?
    private var lastUploadError: String?

    private var liveSessionId: String?
    private var liveSessionTimer: Timer?

    override private init() {
        super.init()
        manager.delegate = self
        manager.pausesLocationUpdatesAutomatically = true
        // Non-negotiable: while a live session is running the OS must show the
        // blue indicator. Hiding it would make this covert tracking (spec §9).
        manager.showsBackgroundLocationIndicator = true
        UIDevice.current.isBatteryMonitoringEnabled = true
    }

    // MARK: - Configuration

    func configure(_ configuration: EngineConfiguration) throws {
        self.configuration = configuration
        applyPosture()
        emitState(reason: "configured")
    }

    // MARK: - Lifecycle

    func startPassiveTracking() throws {
        guard !sharingPaused else {
            // Resuming is an explicit, user-initiated act. Silently starting here
            // would let a caller override a pause the user asked for.
            throw EngineError.sharingPaused
        }
        guard CLLocationManager.locationServicesEnabled() else {
            transition(to: .permissionRequired, reason: "location-services-disabled")
            throw EngineError.locationServicesDisabled
        }

        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
            transition(to: .permissionRequired, reason: "authorization-not-determined")
            throw EngineError.authorizationNotDetermined
        case .denied, .restricted:
            transition(to: .permissionRequired, reason: "authorization-denied")
            throw EngineError.authorizationDenied
        case .authorizedWhenInUse, .authorizedAlways:
            break
        @unknown default:
            transition(to: .permissionRequired, reason: "authorization-unknown")
            throw EngineError.authorizationDenied
        }

        if manager.authorizationStatus == .authorizedAlways {
            manager.allowsBackgroundLocationUpdates = true
            manager.startMonitoringSignificantLocationChanges()
            manager.startMonitoringVisits()
        }

        transition(to: batteryAdjustedAmbientState(), reason: "passive-started")
    }

    func pauseSharing() {
        sharingPaused = true
        stopLiveSession(reason: .stoppedByUser)
        manager.stopUpdatingLocation()
        manager.stopMonitoringSignificantLocationChanges()
        manager.stopMonitoringVisits()
        unregisterAllRegions()
        // Anything already captured but not yet uploaded is discarded: a user who
        // pauses expects nothing further to reach their family.
        queue.removeAll()
        transition(to: .disabled, reason: "sharing-paused")
    }

    func resumeSharing() throws {
        sharingPaused = false
        try startPassiveTracking()
        registerGeofencesInternal()
        emitState(reason: "sharing-resumed")
    }

    // MARK: - Live sessions

    func startLiveSession(sessionId: String, durationSeconds: Double, updateIntervalSeconds _: Double?) throws {
        guard !sharingPaused else { throw EngineError.sharingPaused }
        guard manager.authorizationStatus == .authorizedAlways
            || manager.authorizationStatus == .authorizedWhenInUse
        else {
            throw EngineError.authorizationDenied
        }
        // A live session is the most expensive thing the engine does; refusing it
        // on a nearly-dead battery keeps the device alive to send its last known
        // position, which matters more.
        if batteryLevel().map({ $0 <= configuration.criticalBatteryThreshold }) ?? false {
            throw EngineError.criticalBattery
        }

        stopLiveSession(reason: .stoppedByUser)

        let duration = min(
            EngineConfiguration.liveDurationRange.clamp(durationSeconds),
            configuration.liveSessionMaxSeconds
        )
        liveSessionId = sessionId
        transition(to: .live, reason: "live-session-started")

        manager.desiredAccuracy = TrackingState.live.desiredAccuracy
        manager.distanceFilter = configuration.distanceFilter(for: .live)
        manager.startUpdatingLocation()

        // Hard local deadline. The server also expires the session, but the device
        // must stop on its own even if it is offline when the session ends.
        liveSessionTimer?.invalidate()
        liveSessionTimer = Timer.scheduledTimer(withTimeInterval: duration, repeats: false) { [weak self] _ in
            self?.stopLiveSession(reason: .expired)
        }
    }

    func stopLiveSession(reason: LiveSessionEndReason) {
        guard liveSessionId != nil else { return }
        liveSessionTimer?.invalidate()
        liveSessionTimer = nil
        liveSessionId = nil
        manager.stopUpdatingLocation()
        transition(to: batteryAdjustedAmbientState(), reason: "live-session-ended:\(reason)")
    }

    // MARK: - Geofences

    func registerGeofences(_ regions: [GeofenceRegion]) throws {
        geofences = regions
        registerGeofencesInternal()
    }

    func unregisterGeofences(placeIds: [String]) {
        let removing = Set(placeIds)
        geofences.removeAll { removing.contains($0.placeId) }
        for region in manager.monitoredRegions where removing.contains(region.identifier) {
            manager.stopMonitoring(for: region)
        }
    }

    private func registerGeofencesInternal() {
        guard !sharingPaused,
              CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) else { return }

        unregisterAllRegions()
        let selected = GeofenceRegion.prioritise(geofences, around: lastAcceptedLocation)
        let maximumRadius = manager.maximumRegionMonitoringDistance
        for region in selected {
            manager.startMonitoring(for: region.asCircularRegion(maximumRadius: maximumRadius))
        }
    }

    private func unregisterAllRegions() {
        for region in manager.monitoredRegions {
            manager.stopMonitoring(for: region)
        }
    }

    // MARK: - Reporting

    func permissionState() -> [String: Any?] {
        let status = manager.authorizationStatus
        let authorization = switch status {
        case .notDetermined: "NOT_DETERMINED"
        case .restricted: "RESTRICTED"
        case .denied: "DENIED"
        case .authorizedWhenInUse: "WHEN_IN_USE"
        case .authorizedAlways: "ALWAYS"
        @unknown default: "NOT_DETERMINED"
        }

        return [
            "authorization": authorization,
            "preciseLocationEnabled": manager.accuracyAuthorization == .fullAccuracy,
            "locationServicesEnabled": CLLocationManager.locationServicesEnabled(),
            "notificationsEnabled": NotificationAuthorization.isAuthorized,
            // On iOS this is Background App Refresh: without it, background delivery
            // is unreliable no matter what the location permission says.
            "backgroundRefreshEnabled": UIApplication.shared.backgroundRefreshStatus == .available,
            "foregroundServicePermissionGranted": nil,
            "batteryOptimizationIgnored": nil,
        ]
    }

    func deviceHealth() -> [String: Any?] {
        let formatter = ISO8601DateFormatter()
        return [
            "permission": permissionState(),
            "trackingState": state.rawValue,
            "batteryLevel": batteryLevel(),
            "isLowPowerMode": ProcessInfo.processInfo.isLowPowerModeEnabled,
            "isCharging": UIDevice.current.batteryState == .charging || UIDevice.current.batteryState == .full,
            "pendingEventCount": queue.count,
            "oldestPendingEventAt": queue.oldestCapturedAt.map(formatter.string(from:)),
            "lastAcceptedAt": lastAcceptedLocation.map { formatter.string(from: $0.timestamp) },
            "lastUploadAttemptAt": lastUploadAttemptAt.map(formatter.string(from:)),
            "lastUploadError": lastUploadError,
            "remoteConfigVersion": configuration.configVersion,
        ]
    }

    /**
     * Hands the pending batch to JavaScript, which owns the HTTP call. The native
     * side keeps the queue; the TypeScript side keeps the retry policy, so both
     * halves are testable independently.
     */
    func flushPendingEvents() -> [String: Any?] {
        lastUploadAttemptAt = Date()
        let formatter = ISO8601DateFormatter()
        let batch = queue.peek(limit: configuration.uploadBatchSize)

        return [
            "uploadedCount": 0,
            "remainingCount": queue.count,
            "lastError": lastUploadError,
            "attemptedAt": formatter.string(from: Date()),
            "pending": batch.map { record in
                [
                    "eventId": record.eventId,
                    "sequenceNumber": record.sequenceNumber,
                    "latitude": record.latitude,
                    "longitude": record.longitude,
                    "horizontalAccuracy": record.horizontalAccuracy,
                    "altitude": record.altitude,
                    "speed": record.speed,
                    "heading": record.heading,
                    "batteryLevel": record.batteryLevel,
                    "isLowPowerMode": record.isLowPowerMode,
                    "trackingMode": record.trackingMode,
                    "capturedAt": formatter.string(from: record.capturedAt),
                    "createdAt": formatter.string(from: record.createdAt),
                ]
            },
        ]
    }

    func confirmUploaded(eventIds: [String]) {
        queue.remove(eventIds: Set(eventIds))
        lastUploadError = nil
        emitQueueChange()
    }

    // MARK: - Internals

    private func batteryLevel() -> Double? {
        let level = UIDevice.current.batteryLevel
        return level < 0 ? nil : Double(level)
    }

    /// The ambient state to fall back to, after accounting for battery.
    private func batteryAdjustedAmbientState() -> TrackingState {
        guard !sharingPaused else { return .disabled }
        if let level = batteryLevel() {
            if level <= configuration.criticalBatteryThreshold { return .criticalBattery }
            if level <= configuration.lowBatteryThreshold { return .lowBattery }
        }
        if ProcessInfo.processInfo.isLowPowerModeEnabled { return .lowBattery }
        return .passive
    }

    private func applyPosture() {
        manager.desiredAccuracy = state.desiredAccuracy
        manager.distanceFilter = configuration.distanceFilter(for: state)
        if !state.allowsContinuousUpdates {
            manager.stopUpdatingLocation()
        }
    }

    private func transition(to next: TrackingState, reason: String) {
        guard next != state else { return }
        state = next
        applyPosture()
        emitState(reason: reason)
    }

    private func emitState(reason: String) {
        eventSink?("onEngineStateChange", ["state": state.rawValue, "reason": reason])
    }

    private func emitQueueChange() {
        eventSink?("onQueueChange", ["pendingEventCount": queue.count])
    }

    /**
     * Acceptance gate. A fix that fails any of these is dropped on the device
     * rather than uploaded and rejected by the server — that saves radio, battery
     * and backend cost, and keeps obviously-wrong data out of the family map.
     *
     * No branch here logs a coordinate.
     */
    private func accept(_ location: CLLocation) {
        guard state.producesLocation, !sharingPaused else { return }

        // Negative accuracy is Core Location's "this fix is invalid".
        guard location.horizontalAccuracy >= 0,
              location.horizontalAccuracy <= configuration.maxAcceptableAccuracyMeters else { return }

        let age = -location.timestamp.timeIntervalSinceNow
        guard age <= LocationEventQueue.maxAgeSeconds, age >= -120 else { return }

        if let previous = lastAcceptedLocation {
            let distance = location.distance(from: previous)
            let elapsed = location.timestamp.timeIntervalSince(previous.timestamp)
            // Duplicate: same place, same moment.
            if distance < 20, elapsed < 60 { return }
            // Implausible ground speed implies a spoofed or corrupt fix.
            if elapsed > 0, distance / elapsed > 350 { return }
            // In stationary posture, do not persist repeated identical points.
            if state == .stationary, distance < configuration.distanceFilter(for: .stationary) { return }
        }

        lastAcceptedLocation = location

        queue.enqueue(
            LocationEventQueue.Record(
                eventId: UUID().uuidString,
                sequenceNumber: queue.nextSequenceNumber(),
                latitude: location.coordinate.latitude,
                longitude: location.coordinate.longitude,
                horizontalAccuracy: location.horizontalAccuracy,
                altitude: location.verticalAccuracy >= 0 ? location.altitude : nil,
                speed: location.speed >= 0 ? location.speed : nil,
                heading: location.course >= 0 ? location.course : nil,
                batteryLevel: batteryLevel(),
                isLowPowerMode: ProcessInfo.processInfo.isLowPowerModeEnabled,
                trackingMode: state.rawValue,
                capturedAt: location.timestamp,
                createdAt: Date()
            )
        )
        emitQueueChange()
    }

    enum EngineError: Error {
        case sharingPaused
        case locationServicesDisabled
        case authorizationDenied
        case authorizationNotDetermined
        case criticalBattery
    }
}

// MARK: - CLLocationManagerDelegate

extension LocationEngine: CLLocationManagerDelegate {
    func locationManager(_: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        locations.forEach(accept)
    }

    func locationManager(_: CLLocationManager, didVisit visit: CLVisit) {
        // A visit with a distant-past arrival is a departure record; either way the
        // coordinate is worth storing as a low-frequency anchor point.
        guard visit.horizontalAccuracy >= 0 else { return }
        let timestamp = visit.departureDate == Date.distantFuture ? visit.arrivalDate : visit.departureDate
        accept(
            CLLocation(
                coordinate: visit.coordinate,
                altitude: 0,
                horizontalAccuracy: visit.horizontalAccuracy,
                verticalAccuracy: -1,
                timestamp: timestamp
            )
        )
    }

    func locationManager(_: CLLocationManager, didEnterRegion region: CLRegion) {
        emitGeofence(region: region, transition: "ARRIVAL")
    }

    func locationManager(_: CLLocationManager, didExitRegion region: CLRegion) {
        emitGeofence(region: region, transition: "DEPARTURE")
    }

    private func emitGeofence(region: CLRegion, transition: String) {
        guard !sharingPaused else { return }
        eventSink?(
            "onGeofenceTransition",
            [
                // Opaque identifier only — never the coordinate of the place.
                "placeId": region.identifier,
                "transition": transition,
                "occurredAt": ISO8601DateFormatter().string(from: Date()),
            ]
        )
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        eventSink?("onPermissionChange", permissionState())

        switch manager.authorizationStatus {
        case .denied, .restricted, .notDetermined:
            // A downgrade at any time stops collection immediately.
            manager.stopUpdatingLocation()
            manager.stopMonitoringSignificantLocationChanges()
            manager.stopMonitoringVisits()
            unregisterAllRegions()
            stopLiveSession(reason: .permissionLost)
            transition(to: .permissionRequired, reason: "authorization-downgraded")
        case .authorizedAlways:
            manager.allowsBackgroundLocationUpdates = true
            manager.startMonitoringSignificantLocationChanges()
            manager.startMonitoringVisits()
            registerGeofencesInternal()
            transition(to: batteryAdjustedAmbientState(), reason: "authorization-always")
        case .authorizedWhenInUse:
            // Background delivery is not available; the app still works in the
            // foreground and the UI explains the limitation rather than hiding it.
            manager.allowsBackgroundLocationUpdates = false
            transition(to: batteryAdjustedAmbientState(), reason: "authorization-when-in-use")
        @unknown default:
            break
        }
    }

    func locationManager(_: CLLocationManager, didFailWithError error: Error) {
        // Sanitised: the reason is a code, never a coordinate or a full error dump.
        if let clError = error as? CLError {
            lastUploadError = "core-location-\(clError.code.rawValue)"
        } else {
            lastUploadError = "core-location-unknown"
        }
    }
}

/// Small indirection so the engine does not import UserNotifications eagerly.
private enum NotificationAuthorization {
    /// Updated by the app when it queries notification settings; defaults to
    /// false so the troubleshooting screen errs toward "check your settings".
    static var isAuthorized = false
}
