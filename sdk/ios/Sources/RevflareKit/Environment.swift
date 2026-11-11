import Foundation
import StoreKit
#if canImport(Darwin)
import Darwin
#endif

/// Where this build runs, sent with every RevflareKit request (`environment`) so Revflare can keep test data apart.
///
/// Revflare excludes `sandbox` and `xcode` data from its analytics by default (the web panel's "Include test data"
/// toggle shows it).
public enum RevflareEnvironment: String, Sendable, Equatable, CaseIterable {
    /// Detect it on the device (the default): Simulator or attached debugger → ``xcode``; a StoreKit transaction of
    /// the Xcode or sandbox environment → that; a sandbox receipt (TestFlight, sandbox testers) → ``sandbox``; else
    /// ``production``. Never a value of ``Revflare/environment``.
    case automatic
    /// An App Store build used by real customers.
    case production
    /// TestFlight and sandbox Apple Accounts.
    case sandbox
    /// Runs from Xcode: Simulator, debugger attached, StoreKit configuration files.
    case xcode
}

/// What the environment is detected from (the device in the app, a fake in tests).
protocol EnvironmentSignals: Sendable {
    /// Simulator build or `SIMULATOR_MODEL_IDENTIFIER` set.
    var isSimulator: Bool { get }
    /// A debugger is attached (`P_TRACED`).
    var isDebuggerAttached: Bool { get }
    /// The environment of the verified StoreKit transactions RevflareKit read in this run (iOS 16+), nil when none.
    var transactionEnvironment: RevflareEnvironment? { get }
    /// `Bundle.main.appStoreReceiptURL?.lastPathComponent` ("sandboxReceipt" in TestFlight and sandbox builds).
    var receiptFileName: String? { get }
}

/// Pure detection rules (tested with fake signals). Never touches the network and never calls
/// `AppTransaction.shared` (which can show an App Store sign-in prompt).
enum EnvironmentDetector {
    static func detect(_ signals: EnvironmentSignals) -> RevflareEnvironment {
        if signals.isSimulator { return .xcode }
        if signals.isDebuggerAttached { return .xcode }
        switch signals.transactionEnvironment {
        case .xcode: return .xcode
        case .sandbox: return .sandbox
        default: break
        }
        if signals.receiptFileName == "sandboxReceipt" { return .sandbox }
        return .production
    }

    /// The override when set, else the detected value.
    static func resolve(override: RevflareEnvironment, signals: EnvironmentSignals) -> RevflareEnvironment {
        override == .automatic ? detect(signals) : override
    }
}

/// The environment of the verified transactions seen in this run (in memory only: a later App Store install of a
/// TestFlight build must not stay "sandbox").
enum TransactionEnvironmentRecorder {
    static let seen = Locked<RevflareEnvironment?>(nil)

    static func record(_ environment: RevflareEnvironment) {
        seen.withLock { $0 = environment }
    }

    static func record(_ transaction: Transaction) {
        if #available(iOS 16.0, macOS 13.0, tvOS 16.0, watchOS 9.0, visionOS 1.0, *) {
            switch transaction.environment {
            case .xcode: record(.xcode)
            case .sandbox: record(.sandbox)
            case .production: record(.production)
            default: break
            }
        }
    }
}

/// Reads the device.
struct SystemEnvironmentSignals: EnvironmentSignals {
    var isSimulator: Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return !(ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] ?? "").isEmpty
        #endif
    }

    var isDebuggerAttached: Bool {
        #if canImport(Darwin)
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        let result = mib.withUnsafeMutableBufferPointer { pointer in
            sysctl(pointer.baseAddress, 4, &info, &size, nil, 0)
        }
        guard result == 0 else { return false }
        return (info.kp_proc.p_flag & P_TRACED) != 0
        #else
        return false
        #endif
    }

    var transactionEnvironment: RevflareEnvironment? { TransactionEnvironmentRecorder.seen.current }

    /// `appStoreReceiptURL` is deprecated (iOS 18) but still set; only its file name is read, never the receipt.
    var receiptFileName: String? { Bundle.main.appStoreReceiptURL?.lastPathComponent }
}
