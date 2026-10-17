import Foundation
import XCTest
import LimitLifeboatCore
@testable import FlowLifeboat

private final class SecretStore: CredentialStoreProtocol {
    var reads = 0
    var writes = 0
    func save(snapshot: CredentialSnapshot, for accountID: UUID, accessMode: CredentialAccessMode) throws { writes += 1 }
    func loadSnapshot(for accountID: UUID, accessMode: CredentialAccessMode) throws -> CredentialSnapshot? {
        reads += 1; throw OperationError(message: "Status must never read credentials")
    }
    func deleteSnapshot(for accountID: UUID, accessMode: CredentialAccessMode) throws { XCTFail("Metadata removal must preserve recovery credentials") }
    func hasSnapshot(for accountID: UUID, accessMode: CredentialAccessMode) throws -> Bool { false }
}
final class FlowLifeboatTests: XCTestCase {
    func request(_ root: URL, command: String = "status", id: UUID? = nil) -> Request {
        Request(command: command, dataDir: root.path, accountID: id, provider: nil, label: nil)
    }
    func testStatusIsReadOnlyAndProjectsOnlyNonSecretMetadata() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let legacy = try ProfileRepository(applicationSupportDirectory: root.appendingPathComponent("legacy"))
        let profile = AccountProfile(provider: .codex, label: "Work", identity: AccountIdentity(email: "sample@example.com", source: .manual))
        try legacy.saveProfiles([profile])
        let store = SecretStore()
        let adapter = try Store(request: request(root), homeDirectory: root.appendingPathComponent("home"), credentialStore: store, legacyRepository: legacy)
        let before = try Data(contentsOf: legacy.applicationSupportDirectory.appendingPathComponent("profiles.json"))
        let state = try await adapter.perform(request(root))
        XCTAssertEqual(state["source"] as? String, "legacy")
        XCTAssertEqual((state["accounts"] as? [[String: Any]])?.first?["label"] as? String, "Work")
        XCTAssertEqual(store.reads, 0); XCTAssertEqual(store.writes, 0)
        XCTAssertEqual(try Data(contentsOf: legacy.applicationSupportDirectory.appendingPathComponent("profiles.json")), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: adapter.directory.appendingPathComponent("profiles.json").path))
    }
    func testOperationLockRejectsAnOverlappingWriter() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let first = try Store(request: request(root), credentialStore: SecretStore())
        try withExtendedLifetime(first) {
            XCTAssertThrowsError(try Store(request: request(root), credentialStore: SecretStore()))
        }
    }
    func testRemovingLastAccountDoesNotResurrectTheLegacyStoreOrDeleteCredentials() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let legacy = try ProfileRepository(applicationSupportDirectory: root.appendingPathComponent("legacy"))
        try legacy.saveProfiles([AccountProfile(provider: .claude, label: "Old")])
        let secrets = SecretStore()
        let adapter = try Store(request: request(root), credentialStore: secrets, legacyRepository: legacy)
        let profile = AccountProfile(provider: .codex, label: "Current")
        try adapter.repository.saveProfiles([profile])
        let state = try await adapter.perform(request(root, command: "remove", id: profile.id))
        XCTAssertEqual(state["source"] as? String, "flow")
        XCTAssertEqual((state["accounts"] as? [[String: Any]])?.count, 0)
        XCTAssertEqual(secrets.reads, 0)
        XCTAssertEqual(try legacy.readProfiles().count, 1)
    }
}
