import ExpoModulesCore

/**
 * Expo Modules bridge for the iOS location engine.
 *
 * This file is only a bridge: it validates and marshals, then delegates to
 * `LocationEngine`. Keeping policy out of here means the engine can be unit
 * tested in Swift without the Expo runtime.
 *
 * Every method that could start collecting location is asynchronous and can
 * fail. Nothing here silently succeeds — a caller that cannot start tracking
 * must find out, so the UI can tell the user that sharing is not running.
 */
public final class LocationEngineModule: Module {
    private let engine = LocationEngine.shared

    public func definition() -> ModuleDefinition {
        Name("LocationEngineModule")

        Events(
            "onEngineStateChange",
            "onPermissionChange",
            "onGeofenceTransition",
            "onQueueChange"
        )

        OnCreate {
            engine.eventSink = { [weak self] name, payload in
                self?.sendEvent(name, payload)
            }
        }

        OnDestroy {
            engine.eventSink = nil
        }

        AsyncFunction("configure") { (config: [String: Any]) in
            try engine.configure(EngineConfiguration(dictionary: config))
        }

        AsyncFunction("startPassiveTracking") {
            try engine.startPassiveTracking()
        }

        AsyncFunction("startLiveSession") { (session: [String: Any]) in
            guard
                let sessionId = session["sessionId"] as? String,
                let duration = session["durationSeconds"] as? Double
            else {
                throw InvalidArgumentException("startLiveSession requires sessionId and durationSeconds")
            }
            let interval = session["updateIntervalSeconds"] as? Double
            try engine.startLiveSession(
                sessionId: sessionId,
                durationSeconds: duration,
                updateIntervalSeconds: interval
            )
        }

        AsyncFunction("stopLiveSession") {
            engine.stopLiveSession(reason: .stoppedByUser)
        }

        AsyncFunction("pauseSharing") {
            engine.pauseSharing()
        }

        AsyncFunction("resumeSharing") {
            try engine.resumeSharing()
        }

        AsyncFunction("getPermissionState") { () -> [String: Any?] in
            engine.permissionState()
        }

        AsyncFunction("getDeviceHealth") { () -> [String: Any?] in
            engine.deviceHealth()
        }

        AsyncFunction("flushPendingEvents") { () -> [String: Any?] in
            engine.flushPendingEvents()
        }

        AsyncFunction("registerGeofences") { (places: [[String: Any]]) in
            try engine.registerGeofences(places.compactMap(GeofenceRegion.init(dictionary:)))
        }

        AsyncFunction("unregisterGeofences") { (placeIds: [String]) in
            engine.unregisterGeofences(placeIds: placeIds)
        }
    }
}

/// Thrown when JavaScript hands the bridge something the engine cannot use.
///
/// `GenericException` is the Expo Modules pattern for carrying a payload into
/// the message. Subclassing `Exception` directly and adding a stored `reason`
/// collides with the base class's own computed property of that name.
final class InvalidArgumentException: GenericException<String> {
    override var reason: String {
        param
    }
}
