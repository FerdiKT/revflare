import Foundation
import StoreKit
#if canImport(AdServices)
import AdServices
#endif
#if canImport(AdSupport)
import AdSupport
#endif
#if canImport(AppTrackingTransparency)
import AppTrackingTransparency
#endif
#if canImport(UIKit)
import UIKit
#endif

/// What the attribution token provider returned.
enum TokenResult: Equatable, Sendable {
    case token(String)
    /// AdServices does not exist here (platform not supported): there will never be a token.
    case unavailable
    /// A transient error; Apple recommends trying again.
    case error(String)
}

/// Source of the AdServices attribution token.
protocol AttributionTokenProvider: Sendable {
    func attributionToken() async -> TokenResult
}

/// `AAAttribution.attributionToken()`. The token is valid 24 hours.
struct AdServicesTokenProvider: AttributionTokenProvider {
    func attributionToken() async -> TokenResult {
        #if canImport(AdServices)
        do {
            let token = try AAAttribution.attributionToken()
            return token.isEmpty ? .error("empty token") : .token(token)
        } catch let error as AAAttributionError where error.code == .platformNotSupported {
            return .unavailable
        } catch let error as NSError {
            return .error("\(error.domain) \(error.code): \(error.localizedDescription)")
        }
        #else
        return .unavailable
        #endif
    }
}

/// Source of the original transaction ids this install owns.
protocol TransactionSource: Sendable {
    func originalTransactionIds() async -> Set<String>
}

/// Reads StoreKit 2's `Transaction.all` and `Transaction.currentEntitlements`. Read only: never finishes a
/// transaction, never calls `AppStore.sync()` (which would ask the user to sign in).
struct StoreKitTransactionSource: TransactionSource {
    func originalTransactionIds() async -> Set<String> {
        var ids = Set<String>()
        for await result in Transaction.all { collect(result, into: &ids) }
        for await result in Transaction.currentEntitlements { collect(result, into: &ids) }
        return ids
    }

    private func collect(_ result: VerificationResult<Transaction>, into ids: inout Set<String>) {
        // Only verified transactions; family-shared ones belong to the family member who bought them.
        guard case .verified(let transaction) = result else { return }
        TransactionEnvironmentRecorder.record(transaction)
        guard transaction.ownershipType == .purchased else { return }
        ids.insert(String(transaction.originalID))
    }
}

enum AppInfo {
    static var version: String? {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    }
}

// MARK: Device identifiers (Meta)

/// App Tracking Transparency status, as sent in `attStatus`.
enum TrackingStatus: String, Codable, Sendable {
    case authorized
    case denied
    case restricted
    case notDetermined
    /// No App Tracking Transparency on this platform.
    case unavailable
}

/// What this device reports to `POST /sdk/v1/identifiers`, apart from the install id and the Facebook anonymous id.
/// Only read after the app opted in (``Revflare/setMetaAnonymousID(_:)`` or ``Revflare/collectDeviceIdentifiers()``).
struct DeviceIdentifiers: Equatable, Sendable {
    /// The IDFA (uppercase UUID), only when tracking is authorized and it is not all zeros.
    var idfa: String?
    /// `UIDevice.identifierForVendor` (uppercase UUID).
    var idfv: String?
    var attStatus: TrackingStatus
    var bundleId: String
    /// `CFBundleShortVersionString`.
    var appVersion: String
    /// `CFBundleVersion`.
    var appBuild: String
    var osVersion: String
    /// Hardware model identifier, e.g. "iPhone15,2".
    var deviceModel: String
    /// Locale identifier in underscore form, e.g. "en_US".
    var locale: String
    /// Time zone identifier, e.g. "Europe/Istanbul".
    var timeZone: String
    /// Meta's app events "extinfo" array (16 strings, starting with "i2").
    var extinfo: [String]
}

/// Source of ``DeviceIdentifiers`` (the system in the app, a fake in tests).
protocol DeviceIdentifierProvider: Sendable {
    func deviceIdentifiers() async -> DeviceIdentifiers
}

/// Reads the device: AdSupport / AppTrackingTransparency (never prompts), UIKit (IDFV, screen: read on the main actor,
/// nothing else runs there), `utsname`, the file system.
struct SystemDeviceIdentifierProvider: DeviceIdentifierProvider {
    static let zeroIdfa = "00000000-0000-0000-0000-000000000000"

    func deviceIdentifiers() async -> DeviceIdentifiers {
        let ui = await Self.uiValues()
        let status = Self.trackingStatus()
        let idfa = Self.advertisingId(status: status, rawIdfa: Self.rawIdfa())
        let bundle = Bundle.main
        let bundleId = bundle.bundleIdentifier ?? ""
        let appVersion = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let appBuild = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        let osVersion = Self.osVersion()
        let model = Self.modelIdentifier()
        let locale = Self.localeIdentifier(Locale.current.identifier)
        let timeZone = TimeZone.current
        let extinfo = Self.extinfo(
            bundleId: bundleId,
            appVersion: appVersion,
            buildVersion: appBuild,
            osVersion: osVersion,
            model: model,
            locale: locale,
            timeZoneAbbreviation: timeZone.abbreviation() ?? "",
            carrier: "",
            screenWidth: ui.width,
            screenHeight: ui.height,
            screenScale: ui.scale,
            cpuCores: ProcessInfo.processInfo.processorCount,
            // Disk space is an Apple required-reason API (DiskSpace) with no allowed reason for sending it to an
            // ad network, so extinfo carries 0 for both, as Meta accepts.
            totalDiskGB: 0,
            freeDiskGB: 0,
            timeZoneIdentifier: timeZone.identifier
        )
        return DeviceIdentifiers(
            idfa: idfa,
            idfv: ui.idfv,
            attStatus: status,
            bundleId: bundleId,
            appVersion: appVersion,
            appBuild: appBuild,
            osVersion: osVersion,
            deviceModel: model,
            locale: locale,
            timeZone: timeZone.identifier,
            extinfo: extinfo
        )
    }

    /// Meta's extinfo layout (iOS, version "i2").
    static func extinfo(
        bundleId: String, appVersion: String, buildVersion: String, osVersion: String, model: String,
        locale: String, timeZoneAbbreviation: String, carrier: String,
        screenWidth: Double, screenHeight: Double, screenScale: Double,
        cpuCores: Int, totalDiskGB: Int64, freeDiskGB: Int64, timeZoneIdentifier: String
    ) -> [String] {
        [
            "i2",
            bundleId,
            appVersion,
            buildVersion,
            osVersion,
            model,
            locale,
            timeZoneAbbreviation,
            carrier,
            String(Int(screenWidth.rounded())),
            String(Int(screenHeight.rounded())),
            String(format: "%.2f", locale: Locale(identifier: "en_US_POSIX"), screenScale),
            String(cpuCores),
            String(totalDiskGB),
            String(freeDiskGB),
            timeZoneIdentifier,
        ]
    }

    /// The App Tracking Transparency status. Only reads it: never shows the prompt.
    static func trackingStatus() -> TrackingStatus {
        #if canImport(AppTrackingTransparency)
        if #available(iOS 14, macOS 11, tvOS 14, *) {
            switch ATTrackingManager.trackingAuthorizationStatus {
            case .authorized: return .authorized
            case .denied: return .denied
            case .restricted: return .restricted
            case .notDetermined: return .notDetermined
            @unknown default: return .unavailable
            }
        }
        return .unavailable
        #else
        return .unavailable
        #endif
    }

    /// The IDFA to send: only when tracking is authorized and the system returned a real one (not all zeros).
    static func advertisingId(status: TrackingStatus, rawIdfa: String?) -> String? {
        guard status == .authorized, let value = rawIdfa?.uppercased(), !value.isEmpty, value != zeroIdfa else { return nil }
        return value
    }

    static func rawIdfa() -> String? {
        #if canImport(AdSupport)
        return ASIdentifierManager.shared().advertisingIdentifier.uuidString
        #else
        return nil
        #endif
    }

    /// "en-US", "en_US@rg=gbzzzz" → "en_US".
    static func localeIdentifier(_ identifier: String) -> String {
        let base = identifier.split(separator: "@", maxSplits: 1).first.map(String.init) ?? identifier
        return base.replacingOccurrences(of: "-", with: "_")
    }

    /// e.g. "18.1" or "18.1.1".
    static func osVersion() -> String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return v.patchVersion > 0 ? "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)" : "\(v.majorVersion).\(v.minorVersion)"
    }

    /// The hardware model identifier, e.g. "iPhone15,2" (the simulated device's in the Simulator).
    static func modelIdentifier() -> String {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"], !simulated.isEmpty {
            return simulated
        }
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
    }

    /// IDFV and main screen size (points) and scale, read in one short hop to the main actor (UIKit requires it).
    /// Without UIKit: no IDFV, zeros and scale 1.
    static func uiValues() async -> (idfv: String?, width: Double, height: Double, scale: Double) {
        #if canImport(UIKit) && (os(iOS) || os(tvOS))
        return await MainActor.run {
            let screen = UIScreen.main
            return (
                UIDevice.current.identifierForVendor?.uuidString.uppercased(),
                Double(screen.bounds.width),
                Double(screen.bounds.height),
                Double(screen.scale)
            )
        }
        #else
        return (nil, 0, 0, 1)
        #endif
    }
}

// MARK: Events: timers and background time

/// A scheduled piece of work that can be cancelled.
final class ScheduledWork: Sendable {
    private let cancelAction: @Sendable () -> Void
    init(cancel: @escaping @Sendable () -> Void) { cancelAction = cancel }
    func cancel() { cancelAction() }
}

/// Runs work after a delay (a sleeping task in the app, a manual clock in tests).
protocol EventScheduler: Sendable {
    func schedule(after delay: TimeInterval, _ action: @escaping @Sendable () async -> Void) -> ScheduledWork
}

struct TaskEventScheduler: EventScheduler {
    func schedule(after delay: TimeInterval, _ action: @escaping @Sendable () async -> Void) -> ScheduledWork {
        let task = Task.detached(priority: .utility) {
            try? await Task.sleep(nanoseconds: UInt64(max(0, delay) * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await action()
        }
        return ScheduledWork { task.cancel() }
    }
}

/// Asks the system for time to finish work after the app went to the background.
protocol BackgroundExecution: Sendable {
    /// Calls `work` and keeps the process running until `work` calls its completion (or the system's time runs out).
    func perform(_ reason: String, _ work: @escaping @Sendable (_ done: @escaping @Sendable () -> Void) -> Void)
}

/// `ProcessInfo.performExpiringActivity` (iOS, tvOS, visionOS): works from any thread, in apps and app extensions,
/// without UIKit. On macOS the work just runs.
struct ExpiringActivityExecution: BackgroundExecution {
    /// Never hold the activity longer than this (iOS gives about 30 seconds).
    static let maxWait: TimeInterval = 25

    func perform(_ reason: String, _ work: @escaping @Sendable (_ done: @escaping @Sendable () -> Void) -> Void) {
        #if os(macOS)
        // Mac apps are not suspended in the background.
        work {}
        #else
        let semaphore = DispatchSemaphore(value: 0)
        let started = Locked(false)
        ProcessInfo.processInfo.performExpiringActivity(withReason: reason) { expired in
            if expired {
                // Time is up: let the waiting block return.
                semaphore.signal()
                return
            }
            let first = started.withLock { started -> Bool in
                defer { started = true }
                return !started
            }
            guard first else { return }
            work { semaphore.signal() }
            // This block runs on a system queue (not the cooperative pool); returning ends the activity.
            _ = semaphore.wait(timeout: .now() + Self.maxWait)
        }
        #endif
    }
}

extension Revflare {
    /// Posted when the app goes to the background.
    static var backgroundNotification: Notification.Name? {
        #if os(iOS) || os(tvOS) || os(visionOS)
        return Notification.Name("UIApplicationDidEnterBackgroundNotification")
        #elseif os(macOS)
        return Notification.Name("NSApplicationDidResignActiveNotification")
        #else
        return nil
        #endif
    }
}
