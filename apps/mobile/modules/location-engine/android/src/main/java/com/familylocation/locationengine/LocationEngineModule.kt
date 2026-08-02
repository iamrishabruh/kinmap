package com.familylocation.locationengine

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Expo Modules bridge for the Android location engine.
 *
 * A bridge only: it marshals arguments and delegates to `LocationEngine`, so
 * the engine stays testable without the Expo runtime.
 *
 * Every method that could start collecting location can fail, and failures
 * propagate to JavaScript. Nothing silently succeeds — a caller that cannot
 * start tracking must find out, so the UI can tell the user sharing is off.
 */
class LocationEngineModule : Module() {

    private val engine: LocationEngine
        get() = LocationEngine.getOrCreate(
            appContext.reactContext ?: throw MissingContextException(),
        )

    override fun definition() = ModuleDefinition {
        Name("LocationEngineModule")

        Events(
            "onEngineStateChange",
            "onPermissionChange",
            "onGeofenceTransition",
            "onQueueChange",
        )

        OnCreate {
            engine.eventSink = { name, payload -> sendEvent(name, payload) }
        }

        OnDestroy {
            LocationEngine.instance?.eventSink = null
        }

        AsyncFunction("configure") { config: Map<String, Any?> ->
            engine.configure(EngineConfiguration.fromMap(config))
        }

        AsyncFunction("startPassiveTracking") {
            runOrThrow("startPassiveTracking") { engine.startPassiveTracking() }
        }

        AsyncFunction("startLiveSession") { session: Map<String, Any?> ->
            val sessionId = session["sessionId"] as? String
                ?: throw InvalidArgumentException("startLiveSession requires sessionId")
            val duration = (session["durationSeconds"] as? Number)?.toLong()
                ?: throw InvalidArgumentException("startLiveSession requires durationSeconds")
            runOrThrow("startLiveSession") { engine.startLiveSession(sessionId, duration) }
        }

        AsyncFunction("stopLiveSession") { engine.stopLiveSession() }

        AsyncFunction("pauseSharing") { engine.pauseSharing() }

        AsyncFunction("resumeSharing") {
            runOrThrow("resumeSharing") { engine.resumeSharing() }
        }

        AsyncFunction("getPermissionState") { engine.permissionState() }

        AsyncFunction("getDeviceHealth") { engine.health() }

        AsyncFunction("flushPendingEvents") { engine.pendingBatch() }

        AsyncFunction("confirmUploaded") { eventIds: List<String> ->
            engine.confirmUploaded(eventIds)
        }

        AsyncFunction("registerGeofences") { places: List<Map<String, Any?>> ->
            engine.registerGeofences(places)
        }

        AsyncFunction("unregisterGeofences") { placeIds: List<String> ->
            engine.unregisterGeofences(placeIds)
        }
    }

    /**
     * Converts the engine's `check(...)` preconditions into coded exceptions so
     * JavaScript gets a stable, user-safe reason rather than a stack trace.
     */
    private inline fun runOrThrow(operation: String, block: () -> Unit) {
        try {
            block()
        } catch (error: IllegalStateException) {
            throw EngineStateException(operation, error.message ?: "precondition failed")
        }
    }
}

internal class MissingContextException :
    CodedException("The Android context is not available; the module is not attached.")

internal class InvalidArgumentException(reason: String) : CodedException(reason)

internal class EngineStateException(operation: String, reason: String) :
    CodedException("$operation could not run: $reason")
