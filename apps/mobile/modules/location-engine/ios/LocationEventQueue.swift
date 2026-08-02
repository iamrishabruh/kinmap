import CryptoKit
import Foundation
import Security

/**
 * Encrypted, ordered, on-disk queue of pending location events (spec §11).
 *
 * Design constraints that drive the shape of this file:
 *
 *  - It must survive app termination and device restart, so it is a file, not
 *    an in-memory buffer.
 *  - Coordinates at rest on the device are encrypted with AES-GCM under a key
 *    held in the Keychain with `ThisDeviceOnly` accessibility, so a backup
 *    restored onto another device cannot read them.
 *  - Order per device must be preserved, so every record carries a monotonic
 *    sequence number that is persisted alongside the queue.
 *  - It must be bounded. An offline phone that never drains would otherwise
 *    grow without limit; the oldest records are dropped first and the drop is
 *    counted so the backend can see it happened.
 */
final class LocationEventQueue {
    struct Record: Codable {
        let eventId: String
        let sequenceNumber: Int
        let latitude: Double
        let longitude: Double
        let horizontalAccuracy: Double
        let altitude: Double?
        let speed: Double?
        let heading: Double?
        let batteryLevel: Double?
        let isLowPowerMode: Bool
        let trackingMode: String
        let capturedAt: Date
        let createdAt: Date
    }

    private struct Envelope: Codable {
        let nonce: Data
        let ciphertext: Data
        let tag: Data
    }

    private struct Persisted: Codable {
        var nextSequenceNumber: Int
        var droppedCount: Int
        var envelopes: [Envelope]
    }

    static let maxRecords = 5000
    static let maxAgeSeconds: TimeInterval = 72 * 3600

    private let fileURL: URL
    private let keychainTag = "com.familylocation.locationengine.queuekey"
    private let queue = DispatchQueue(label: "com.familylocation.locationengine.queue")
    private var state: Persisted

    init() {
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("LocationEngine", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        fileURL = directory.appendingPathComponent("queue.bin")
        state = Persisted(nextSequenceNumber: 0, droppedCount: 0, envelopes: [])
        load()
    }

    // MARK: - Public surface

    var count: Int {
        queue.sync { state.envelopes.count }
    }

    var oldestCapturedAt: Date? {
        queue.sync { decodeAll().first?.capturedAt }
    }

    func nextSequenceNumber() -> Int {
        queue.sync {
            let next = state.nextSequenceNumber
            state.nextSequenceNumber += 1
            persist()
            return next
        }
    }

    func enqueue(_ record: Record) {
        queue.sync {
            guard let envelope = seal(record) else { return }
            state.envelopes.append(envelope)
            trimLocked()
            persist()
        }
    }

    /// Oldest-first batch, leaving the records in place until they are confirmed.
    func peek(limit: Int) -> [Record] {
        queue.sync { Array(decodeAll().prefix(max(0, limit))) }
    }

    /// Removes confirmed events. Unknown ids are ignored so a duplicated
    /// confirmation is harmless.
    func remove(eventIds: Set<String>) {
        queue.sync {
            let remaining = decodeAll().filter { !eventIds.contains($0.eventId) }
            state.envelopes = remaining.compactMap(seal)
            persist()
        }
    }

    func removeAll() {
        queue.sync {
            state.envelopes.removeAll()
            persist()
        }
    }

    /// Number of records discarded because the queue was full or they aged out.
    var droppedCount: Int {
        queue.sync { state.droppedCount }
    }

    // MARK: - Retention

    private func trimLocked() {
        var records = decodeAll()
        let cutoff = Date().addingTimeInterval(-Self.maxAgeSeconds)

        let beforeAge = records.count
        records.removeAll { $0.capturedAt < cutoff }
        var dropped = beforeAge - records.count

        if records.count > Self.maxRecords {
            // Drop oldest first: a recent position is more useful to a family than a
            // stale one, and the newest fix is what the map shows.
            dropped += records.count - Self.maxRecords
            records = Array(records.suffix(Self.maxRecords))
        }

        if dropped > 0 {
            state.droppedCount += dropped
            state.envelopes = records.compactMap(seal)
        }
    }

    // MARK: - Encryption

    private func decodeAll() -> [Record] {
        guard let key = loadOrCreateKey() else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return state.envelopes.compactMap { envelope in
            guard
                let box = try? AES.GCM.SealedBox(
                    nonce: AES.GCM.Nonce(data: envelope.nonce),
                    ciphertext: envelope.ciphertext,
                    tag: envelope.tag
                ),
                let plaintext = try? AES.GCM.open(box, using: key)
            else {
                // A record that will not decrypt is unrecoverable; dropping it is the
                // only option, and it must never be surfaced in plaintext anywhere.
                return nil
            }
            return try? decoder.decode(Record.self, from: plaintext)
        }
        .sorted { $0.sequenceNumber < $1.sequenceNumber }
    }

    private func seal(_ record: Record) -> Envelope? {
        guard let key = loadOrCreateKey() else { return nil }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard
            let plaintext = try? encoder.encode(record),
            let box = try? AES.GCM.seal(plaintext, using: key)
        else { return nil }
        return Envelope(nonce: Data(box.nonce), ciphertext: box.ciphertext, tag: box.tag)
    }

    private func loadOrCreateKey() -> SymmetricKey? {
        if let existing = readKeychain() {
            return SymmetricKey(data: existing)
        }
        let key = SymmetricKey(size: .bits256)
        let data = key.withUnsafeBytes { Data($0) }
        return writeKeychain(data) ? key : nil
    }

    private func readKeychain() -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: keychainTag,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    private func writeKeychain(_ data: Data) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: keychainTag,
            kSecValueData as String: data,
            // Available after first unlock so background relaunches can drain the
            // queue, but never migrated to another device by a backup.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        SecItemDelete(query as CFDictionary)
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    // MARK: - Persistence

    private func persist() {
        guard let encoded = try? JSONEncoder().encode(state) else { return }
        try? encoded.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func load() {
        guard
            let data = try? Data(contentsOf: fileURL),
            let decoded = try? JSONDecoder().decode(Persisted.self, from: data)
        else { return }
        state = decoded
    }
}
