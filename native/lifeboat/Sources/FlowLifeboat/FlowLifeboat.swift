import CryptoKit
import AppKit
import Darwin
import Foundation
import LimitLifeboatCore

// One bounded request per process. Only this executable handles secret bytes.
// BB receives metadata, never snapshots, provider responses, or credentials.
struct Request: Decodable {
    let command: String
    let dataDir: String
    let accountID: UUID?
    let provider: Provider?
    let label: String?
}
struct OperationError: Error { let message: String }

@main struct FlowLifeboat {
    static func main() async {
        do {
            let bytes = FileHandle.standardInput.readDataToEndOfFile()
            guard bytes.count <= 16_384 else { throw OperationError(message: "Request is too large.") }
            let request = try JSONDecoder().decode(Request.self, from: bytes)
            let store = try Store(request: request)
            let result = try await store.perform(request)
            FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: ["ok": true, "state": result], options: [.sortedKeys]))
        } catch {
            let message: String
            if let error = error as? OperationError { message = error.message }
            else if let error = error as? CredentialStoreError, error.isKeychainAccessDenied {
                message = "Keychain access is needed on this Mac. Retry from Lifeboat and approve the macOS authorization."
            } else if let error = error as? CLISwitcherError {
                switch error {
                case .rollbackConflict(_, let directory, _, _):
                    message = "Another process changed the login during recovery. Its changes were preserved. Recovery material: \(directory.path)"
                case .unsupportedCodexCredentialStore:
                    message = "Codex uses a non-file credential store. Set cli_auth_credentials_store to file in ~/.codex/config.toml, then retry."
                case .credentialConflict:
                    message = "The login changed in another process. That change was preserved. Refresh and retry."
                case .restoreValidationFailed:
                    message = "The target identity could not be verified. The previous login was restored. Sign in again, capture the login, then retry."
                default: message = "The saved login could not be used. Capture it again from the provider CLI, then retry."
                }
            } else if error is ClaudeOAuthRefreshCoordinatorError {
                message = "Claude credentials are busy or use an unsupported configuration. Let the current login finish, then retry."
            } else { message = "Lifeboat could not finish this operation. No success was recorded. Retry, or sign in and capture the CLI login again." }
            let response = try! JSONSerialization.data(withJSONObject: ["ok": false, "error": message])
            FileHandle.standardOutput.write(response)
            exit(1)
        }
    }
}

final class Store {
    let directory: URL
    let repository: ProfileRepository
    let credentials: CredentialStoreProtocol
    let switcher: CLISwitcher
    let coordinator = ClaudeOAuthRefreshCoordinator()
    let claude: ClaudeAccountUsageService
    let history: UsageHistoryStore
    let legacyOverride: ProfileRepository?
    var lock: Int32 = -1

    init(request: Request, homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
         credentialStore: CredentialStoreProtocol? = nil, legacyRepository: ProfileRepository? = nil) throws {
        guard request.dataDir.hasPrefix("/") else { throw OperationError(message: "A host-local data directory is required.") }
        directory = URL(fileURLWithPath: request.dataDir, isDirectory: true).appendingPathComponent("lifeboat", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        repository = try ProfileRepository(applicationSupportDirectory: directory)
        let namespace = SHA256.hash(data: Data(directory.path.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
        let service = "app.bb.jb-flow.lifeboat.\(namespace)"
        credentials = credentialStore ?? KeychainCredentialStore(service: service)
        legacyOverride = legacyRepository
        switcher = CLISwitcher(homeDirectory: homeDirectory, backupDirectory: directory.appendingPathComponent("recovery"), credentialStore: credentials, requiresClaudeOAuthLease: true)
        claude = ClaudeAccountUsageService(credentials: switcher, refreshCoordinator: coordinator,
            recoveryStore: KeychainClaudeRotationRecoveryStore(service: service + ".rotation-recovery"))
        history = try UsageHistoryStore(applicationSupportDirectory: directory)
        lock = open(directory.appendingPathComponent("operation.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
        guard lock >= 0, flock(lock, LOCK_EX | LOCK_NB) == 0 else {
            if lock >= 0 { close(lock); lock = -1 }
            throw OperationError(message: "Another Lifeboat operation is running on this Mac. Wait for it to finish, then retry.")
        }
    }
    deinit { if lock >= 0 { flock(lock, LOCK_UN); close(lock) } }

    func perform(_ request: Request) async throws -> [String: Any] {
        switch request.command {
        case "status": break
        case "import": try importAccounts()
        case "capture":
            guard let provider = request.provider else { throw OperationError(message: "Choose a provider first.") }
            _ = try capture(provider, access: .userInitiated)
        case "refresh", "background":
            let access: CredentialAccessMode = request.command == "background" ? .nonInteractive : .userInitiated
            if let id = request.accountID { _ = try find(id) }
            try reconcileCLIIdentities()
            let readings = try repository.readUsageSnapshots()
            let deadline = Date().addingTimeInterval(60)
            // Oldest first keeps a large account set progressing across bounded
            // passes. Scheduled work cannot rotate the live Claude chain.
            let profiles = try repository.readProfiles().sorted {
                (readings[$0.id]?.lastRefreshed ?? .distantPast) < (readings[$1.id]?.lastRefreshed ?? .distantPast)
            }
            for profile in profiles where request.accountID == nil || profile.id == request.accountID {
                if let until = backoff()[profile.provider.rawValue], until > Date().timeIntervalSince1970 {
                    try setIssue(profile.id, "The provider asked us to wait. Refresh after \(Date(timeIntervalSince1970: until).formatted(date: .omitted, time: .shortened)). Your last reading is kept.")
                    continue
                }
                if Date() > deadline {
                    try setIssue(profile.id, "This refresh pass reached its time budget. This account will be tried first on a later pass.")
                    continue
                }
                do { try await refresh(profile, access: access, rotationIntent: request.command == "refresh" ? .userRetry : .scheduledReadOnly) }
                catch {
                    if let error = error as? ClaudeAccountUsageFetchError, case .rateLimited(let retryAfter) = error {
                        try setBackoff(profile.provider, until: Date().addingTimeInterval(max(60, retryAfter ?? 300)))
                    }
                    try setIssue(profile.id, "Usage could not be refreshed. Your last reading is kept. Retry, or sign in again and capture the login.")
                }
            }
        case "switch":
            let profile = try find(request.accountID)
            if profile.provider == .claude {
                try await coordinator.withLease { _ in try await self.switchAccount(profile) }
            } else { try await switchAccount(profile) }
        case "rename":
            let profile = try find(request.accountID)
            let label = (request.label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !label.isEmpty, label.count <= 80 else { throw OperationError(message: "Use an account name between 1 and 80 characters.") }
            var profiles = try repository.readProfiles()
            if let index = profiles.firstIndex(where: { $0.id == profile.id }) { profiles[index].label = label; profiles[index].updatedAt = Date() }
            try repository.saveProfiles(profiles)
        case "remove":
            let profile = try find(request.accountID)
            // Removal is metadata-only. Keeping the encrypted snapshot avoids
            // destroying the only owner of a fresh OAuth generation/recovery.
            try repository.saveProfiles(repository.readProfiles().filter { $0.id != profile.id })
        default: throw OperationError(message: "Unknown Lifeboat operation.")
        }
        return try status()
    }

    func find(_ id: UUID?) throws -> AccountProfile {
        guard let id, let profile = try repository.readProfiles().first(where: { $0.id == id }) else {
            throw OperationError(message: "This account is no longer available. Refresh the account list.")
        }
        return profile
    }

    func importAccounts() throws {
        guard NSRunningApplication.runningApplications(withBundleIdentifier: "com.limitlifeboat.app").isEmpty else {
            throw OperationError(message: "Quit the Limit Lifeboat Mac app before importing, so Flow can take over refreshing these logins.")
        }
        let legacy = try legacyOverride ?? ProfileRepository()
        let legacyCredentials = KeychainCredentialStore()
        var profiles = try repository.readProfiles()
        var snapshots = try repository.readUsageSnapshots()
        let legacySnapshots = try legacy.readUsageSnapshots()
        for var profile in try legacy.readProfiles() where !profiles.contains(where: { $0.id == profile.id }) {
            guard profiles.count < 200 else { throw OperationError(message: "Flow supports up to 200 saved accounts per Mac.") }
            // Save each completed account independently. A denied Keychain
            // request leaves earlier imports usable and the source untouched.
            guard let snapshot = try legacyCredentials.loadSnapshot(for: profile.id, accessMode: .userInitiated) else { continue }
            try credentials.save(snapshot: snapshot, for: profile.id, accessMode: .userInitiated)
            profile.isActiveCLI = false // Reconciled from the CLI on explicit capture/switch.
            profiles.append(profile)
            if let reading = legacySnapshots[profile.id] { snapshots[profile.id] = reading }
            try repository.saveProfiles(profiles)
            try repository.saveUsageSnapshots(snapshots)
        }
        let historyURL = directory.appendingPathComponent("usage-history.jsonl")
        if !FileManager.default.fileExists(atPath: historyURL.path) {
            let records = readHistory(from: legacy.applicationSupportDirectory)
            let lines = try records.map { try JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys]) }
            var data = Data()
            for line in lines { data.append(line); data.append(10) }
            try data.write(to: historyURL, options: .atomic)
        }
    }

    @discardableResult func capture(_ provider: Provider, access: CredentialAccessMode) throws -> AccountProfile {
        let observation = try switcher.liveObservation(provider: provider, accessMode: access)
        guard observation.isLoggedIn, let identity = observation.identity, identity.isLikelyValid else {
            throw OperationError(message: "Sign in with \(provider.commandName) on this Mac first, then capture the login.")
        }
        var profiles = try repository.readProfiles()
        var profile = profiles.first { $0.provider == provider && $0.identity?.matches(identity) == true }
            ?? AccountProfile(provider: provider, label: identity.email ?? identity.displayName ?? provider.displayName, identity: identity)
        guard profiles.count < 200 || profiles.contains(where: { $0.id == profile.id }) else {
            throw OperationError(message: "Flow supports up to 200 saved accounts per Mac.")
        }
        profile.identity = identity
        profile.isActiveCLI = true
        profile.updatedAt = Date()
        _ = try switcher.storeObservation(observation, for: profile, accessMode: access)
        profiles = profiles.map { existing in
            var next = existing
            if next.provider == provider { next.isActiveCLI = false }
            return next
        }
        if let index = profiles.firstIndex(where: { $0.id == profile.id }) { profiles[index] = profile } else { profiles.append(profile) }
        try repository.saveProfiles(profiles)
        try setIssue(profile.id, nil)
        return profile
    }

    // Recognize external CLI logins without capturing secrets or guessing the
    // owner of a reading. A denied noninteractive read preserves the last
    // observation; the next explicit capture can authorize it.
    func reconcileCLIIdentities() throws {
        var profiles = try repository.readProfiles()
        var changed = false
        for provider in Provider.allCases {
            guard let observation = try? switcher.liveObservation(provider: provider, accessMode: .nonInteractive),
                  !observation.isLoggedIn || observation.identity?.isLikelyValid == true else { continue }
            for index in profiles.indices where profiles[index].provider == provider {
                let active = observation.isLoggedIn && observation.identity.map { profiles[index].identity?.matches($0) == true } == true
                if profiles[index].isActiveCLI != active { profiles[index].isActiveCLI = active; changed = true }
            }
        }
        if changed { try repository.saveProfiles(profiles) }
    }

    func refresh(_ profile: AccountProfile, access: CredentialAccessMode, rotationIntent: ClaudeRotationIntent = .scheduledReadOnly) async throws {
        let snapshot: UsageSnapshot
        if profile.provider == .claude {
            let result = try await claude.fetchSnapshot(for: profile, isActiveCLI: profile.isActiveCLI,
                accessMode: access, rotationIntent: rotationIntent, expectedIdentity: profile.identity)
            snapshot = result.snapshot
        } else {
            guard let record = try switcher.storedCredentialRecord(for: profile, accessMode: access), let auth = record.codexAuthJSON,
                  let path = switcher.resolveExecutablePath(command: "codex") else {
                throw OperationError(message: "Install Codex and capture its login, then retry.")
            }
            let baseline = try switcher.liveObservation(provider: .codex, accessMode: .nonInteractive)
            let result = try await CodexAccountUsageService().fetchSnapshot(for: profile, authJSON: auth,
                executableURL: URL(fileURLWithPath: path), expectedIdentity: profile.identity)
            guard try switcher.replaceStoredCodexAuthJSON(result.updatedAuthJSON, for: profile.id, using: record,
                ifSnapshotFingerprintMatches: record.summary.fingerprint, accessMode: access) != nil else {
                throw OperationError(message: "The saved login changed during refresh. Refresh again.")
            }
            if let identity = profile.identity ?? result.accountInfo.identity,
               baseline.identity?.matches(identity) == true,
               let fingerprint = baseline.credentialFingerprint {
                _ = try switcher.replaceLiveCodexAuthJSON(result.updatedAuthJSON, ifCredentialFingerprintMatches: fingerprint)
            }
            snapshot = result.snapshot
        }
        var snapshots = try repository.readUsageSnapshots()
        snapshots[profile.id] = snapshot
        try repository.saveUsageSnapshots(snapshots)
        try history.append(snapshot)
        try setIssue(profile.id, nil)
    }

    func switchAccount(_ profile: AccountProfile) async throws {
        let baseline = try switcher.liveObservation(provider: profile.provider, accessMode: .userInitiated)
        // Capture the outgoing login before doing anything to the target.
        if baseline.isLoggedIn, baseline.identity?.isLikelyValid == true { _ = try capture(profile.provider, access: .userInitiated) }
        guard let record = try switcher.storedCredentialRecord(for: profile, accessMode: .userInitiated) else {
            throw OperationError(message: "This account has no saved login. Sign in and capture it first.")
        }
        // Preflight the target in isolation. Claude stays read-only, so this
        // adapter never starts a refresh-token rotation that it cannot repair.
        try await refresh(profile, access: .userInitiated)
        guard let verifiedRecord = try switcher.storedCredentialRecord(for: profile, accessMode: .userInitiated),
              verifiedRecord.summary.provider == record.summary.provider else { throw OperationError(message: "The target login is unavailable.") }
        _ = try switcher.restoreSnapshot(for: profile, storedRecord: verifiedRecord,
            expectedLiveFingerprint: baseline.credentialFingerprint, enforceExpectedLiveState: true, accessMode: .userInitiated)
        var profiles = try repository.readProfiles()
        for index in profiles.indices where profiles[index].provider == profile.provider {
            profiles[index].isActiveCLI = profiles[index].id == profile.id
        }
        try repository.saveProfiles(profiles)
    }

    func issueURL() -> URL { directory.appendingPathComponent("issues.json") }
    func backoff() -> [String: TimeInterval] {
        guard let data = try? Data(contentsOf: directory.appendingPathComponent("backoff.json")) else { return [:] }
        return (try? JSONDecoder().decode([String: TimeInterval].self, from: data)) ?? [:]
    }
    func setBackoff(_ provider: Provider, until: Date) throws {
        var values = backoff(); values[provider.rawValue] = until.timeIntervalSince1970
        try JSONEncoder().encode(values).write(to: directory.appendingPathComponent("backoff.json"), options: .atomic)
    }
    func issues() -> [String: String] {
        guard let data = try? Data(contentsOf: issueURL()) else { return [:] }
        return (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
    }
    func setIssue(_ id: UUID, _ message: String?) throws {
        var values = issues(); values[id.uuidString] = message
        try JSONEncoder().encode(values).write(to: issueURL(), options: .atomic)
    }

    func status() throws -> [String: Any] {
        let owned = try repository.readProfiles()
        let legacy = try legacyOverride ?? ProfileRepository()
        let mayPreview = owned.isEmpty && !FileManager.default.fileExists(atPath: directory.appendingPathComponent("profiles.json").path)
        let legacyProfiles = mayPreview ? try legacy.readProfiles() : []
        let preview = mayPreview && !legacyProfiles.isEmpty
        let profiles = preview ? legacyProfiles : owned
        let snapshots = preview ? try legacy.readUsageSnapshots() : try repository.readUsageSnapshots()
        let report = CLIStatusReportBuilder.report(profiles: profiles, snapshots: snapshots)
        let reportData = try JSONEncoder.appEncoder.encode(report)
        var result = try JSONSerialization.jsonObject(with: reportData) as! [String: Any]
        result["source"] = preview ? "legacy" : "flow"
        result["issues"] = preview ? [:] : issues()
        result["history"] = readHistory(from: preview ? legacy.applicationSupportDirectory : directory)
        let table = SystemProcessTable()
        let sessions = AgentSessionCensusBuilder().sessions(from: table.records(), excludingDescendantsOf: ProcessInfo.processInfo.processIdentifier, workingDirectory: table.workingDirectory(pid:))
        result["sessions"] = sessions.prefix(200).map { session -> [String: Any] in
            ["pid": Int(session.pid), "provider": session.provider.rawValue, "project": session.projectName,
             "memoryBytes": session.footprintBytes, "startedAt": ISO8601DateFormatter().string(from: session.startedAt)]
        }
        if let memory = SystemMemoryReader().read() {
            let assessment = MemoryGuardPolicy().assess(memory: memory, sessions: sessions, lastActivity: [:], now: Date())
            let state = MemoryGuardState(assessment: assessment, now: Date())
            result["memory"] = ["level": state.level, "availableBytes": state.availableBytes,
                "sessionBytes": state.sessionFootprintBytes, "additionalSessions": assessment.estimatedAdditionalSessions as Any? ?? NSNull(), "message": state.message]
        }
        return result
    }

    func readHistory(from base: URL) -> [[String: Any]] {
        guard let handle = try? FileHandle(forReadingFrom: base.appendingPathComponent("usage-history.jsonl")) else { return [] }
        defer { try? handle.close() }
        guard let size = try? handle.seekToEnd() else { return [] }
        try? handle.seek(toOffset: size > 1_048_576 ? size - 1_048_576 : 0)
        guard let data = try? handle.readToEnd() else { return [] }
        let cutoff = Date().addingTimeInterval(-7 * 86_400)
        return data.split(separator: 10).suffix(3000).compactMap { bytes in
            guard let record = try? JSONDecoder.appDecoder.decode(UsageHistoryRecord.self, from: Data(bytes)), record.timestamp >= cutoff,
                  let encoded = try? JSONEncoder.appEncoder.encode(record), let object = try? JSONSerialization.jsonObject(with: encoded) as? [String: Any] else { return nil }
            return object
        }
    }
}
