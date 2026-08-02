import CoreLocation
import Foundation

/**
 * A saved place, translated into something Core Location can monitor.
 *
 * iOS allows at most 20 monitored regions per app, shared across the whole
 * process. Saved places are therefore prioritised rather than registered
 * blindly — see `GeofenceRegion.prioritise`.
 */
struct GeofenceRegion {
    /// Apple's hard limit on simultaneously monitored regions.
    static let maxMonitoredRegions = 20

    let placeId: String
    let latitude: Double
    let longitude: Double
    let radiusMeters: Double
    let notifyOnArrival: Bool
    let notifyOnDeparture: Bool

    init?(dictionary: [String: Any]) {
        guard
            let placeId = dictionary["placeId"] as? String,
            let latitude = dictionary["latitude"] as? Double,
            let longitude = dictionary["longitude"] as? Double,
            let radius = dictionary["radiusMeters"] as? Double,
            CLLocationCoordinate2DIsValid(CLLocationCoordinate2D(latitude: latitude, longitude: longitude))
        else {
            return nil
        }
        self.placeId = placeId
        self.latitude = latitude
        self.longitude = longitude
        radiusMeters = radius
        notifyOnArrival = dictionary["notifyOnArrival"] as? Bool ?? true
        notifyOnDeparture = dictionary["notifyOnDeparture"] as? Bool ?? true
    }

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }

    func asCircularRegion(maximumRadius: CLLocationDistance) -> CLCircularRegion {
        let region = CLCircularRegion(
            center: coordinate,
            radius: min(radiusMeters, maximumRadius),
            identifier: placeId
        )
        region.notifyOnEntry = notifyOnArrival
        region.notifyOnExit = notifyOnDeparture
        return region
    }

    /**
     * Chooses which regions to monitor when there are more saved places than iOS
     * will accept. Nearest-first: a place the user is far from cannot produce a
     * transition soon, so it is the cheapest one to stop watching.
     */
    static func prioritise(
        _ regions: [GeofenceRegion],
        around location: CLLocation?,
        limit: Int = maxMonitoredRegions
    ) -> [GeofenceRegion] {
        guard regions.count > limit else { return regions }
        guard let location else { return Array(regions.prefix(limit)) }

        return regions
            .sorted { left, right in
                let leftDistance = CLLocation(latitude: left.latitude, longitude: left.longitude)
                    .distance(from: location)
                let rightDistance = CLLocation(latitude: right.latitude, longitude: right.longitude)
                    .distance(from: location)
                return leftDistance < rightDistance
            }
            .prefix(limit)
            .map { $0 }
    }
}
