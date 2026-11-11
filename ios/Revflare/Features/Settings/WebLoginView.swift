import LocalAuthentication
import SwiftUI

/// Approves or denies a browser's sign-in request (docs/app-login-spec.md): shows where it comes from, then Face ID /
/// passcode. QR requests have Approve; push requests show three numbers, one of them on the computer's screen (a
/// wrong pick denies the request on the server).
struct WebLoginSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var request: AppModel.WebLoginRequest

    private enum Outcome { case approved, denied }

    @State private var info: WebLoginInfo?
    @State private var error: String?
    @State private var working = false
    @State private var outcome: Outcome?
    @State private var now = Date()

    private var host: String { model.serverURL?.host() ?? "" }
    private var expired: Bool { info.map { now.timeIntervalSince1970 * 1000 >= $0.expiresAt } ?? false }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 22) {
                    BrandMark(size: 64).padding(.top, 8)
                    Text("Sign in to \(host)?")
                        .font(.title2.bold())
                        .multilineTextAlignment(.center)
                    content
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 24)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity)
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(working)
        .task { await load() }
        .task(id: info?.expiresAt) {
            while !Task.isCancelled, info != nil, !expired {
                try? await Task.sleep(for: .seconds(1))
                now = Date()
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let outcome {
            VStack(spacing: 12) {
                Image(systemName: outcome == .approved ? "checkmark.circle.fill" : "xmark.circle.fill")
                    .font(.system(size: 56))
                    .foregroundStyle(outcome == .approved ? .green : .secondary)
                Text(outcome == .approved ? "Approved. The computer is signing in." : "Denied. The computer was not signed in.")
                    .font(.headline)
                    .multilineTextAlignment(.center)
            }
            .padding(.top, 12)
            .task {
                try? await Task.sleep(for: .seconds(1.6))
                dismiss()
            }
        } else if let error {
            VStack(spacing: 14) {
                Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 44)).foregroundStyle(.orange)
                Text(error).multilineTextAlignment(.center).foregroundStyle(.secondary)
                Button("Close") { dismiss() }.buttonStyle(.glass).controlSize(.large)
            }
            .padding(.top, 8)
        } else if let info {
            details(info)
            if expired {
                Text("This request has expired. Show a new code on the computer.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button("Close") { dismiss() }.buttonStyle(.glass).controlSize(.large)
            } else {
                Label("Only approve if you are signing in right now. Revflare will never ask you to approve a request someone else sends you.", systemImage: "exclamationmark.shield")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                actions(info)
            }
        } else {
            ProgressView().controlSize(.large).padding(.vertical, 40)
        }
    }

    private func details(_ info: WebLoginInfo) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Label {
                Text("\(info.browser) on \(info.os)")
            } icon: {
                Image(systemName: info.os == "iOS" || info.os == "Android" ? "iphone" : "desktopcomputer")
            }
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(info.place ?? String(localized: "Unknown location"))
                    if let ip = info.ip { Text(ip).font(.footnote.monospaced()).foregroundStyle(.secondary) }
                }
            } icon: {
                Image(systemName: "mappin.and.ellipse")
            }
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(Date(timeIntervalSince1970: info.createdAt / 1000), format: .dateTime.hour().minute().second())
                    if !expired {
                        Text("Expires in \(remaining(info))").font(.footnote).foregroundStyle(.secondary).monospacedDigit()
                    }
                }
            } icon: {
                Image(systemName: "clock")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    @ViewBuilder
    private func actions(_ info: WebLoginInfo) -> some View {
        VStack(spacing: 12) {
            if info.isPush, let numbers = info.numbers {
                Text("Tap the number shown on the computer")
                    .font(.headline)
                HStack(spacing: 14) {
                    ForEach(numbers, id: \.self) { n in
                        Button {
                            Task { await approve(number: n) }
                        } label: {
                            Text(String(n))
                                .font(.system(size: 34, weight: .semibold, design: .rounded))
                                .monospacedDigit()
                                .frame(maxWidth: .infinity, minHeight: 64)
                        }
                        .buttonStyle(.glass)
                        .accessibilityLabel(Text("Number \(n)"))
                    }
                }
            } else {
                Button {
                    Task { await approve(number: nil) }
                } label: {
                    Label("Approve", systemImage: biometryIcon)
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.glassProminent)
                .controlSize(.large)
            }
            Button(role: .destructive) {
                Task { await deny() }
            } label: {
                Text("Deny").frame(maxWidth: .infinity).padding(.vertical, 6)
            }
            .buttonStyle(.glass)
            .controlSize(.large)
            if working { ProgressView() }
        }
        .disabled(working)
        .padding(.top, 4)
    }

    private func remaining(_ info: WebLoginInfo) -> String {
        let s = max(0, Int((info.expiresAt / 1000 - now.timeIntervalSince1970).rounded(.up)))
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    private var biometryIcon: String {
        let c = LAContext()
        _ = c.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch c.biometryType {
        case .touchID: return "touchid"
        case .opticID: return "opticid"
        case .faceID: return "faceid"
        default: return "lock"
        }
    }

    // MARK: Actions

    private func load() async {
        guard let client = model.client else { return }
        // A QR code names its server: it must be the one this app is signed in to.
        if let server = request.server, let mine = model.serverURL, !AppModel.sameServer(server, mine) {
            error = String(localized: "This code is for another server (\(server.host() ?? server.absoluteString)). This app is signed in to \(host).")
            return
        }
        do {
            info = try await client.inspectWebLogin(request.id, nonce: request.nonce)
            now = Date()
        } catch {
            self.error = message(for: error)
        }
    }

    /// Face ID / Touch ID, falling back to the passcode. Devices without a passcode cannot prompt and pass.
    private func authenticate() async -> Bool {
        let context = LAContext()
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else { return true }
        return (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: String(localized: "Sign in on a computer"))) == true
    }

    private func approve(number: Int?) async {
        guard let client = model.client else { return }
        working = true
        defer { working = false }
        guard await authenticate() else { return }
        do {
            try await client.approveWebLogin(request.id, nonce: request.nonce, number: number)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            outcome = .approved
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = message(for: error)
        }
    }

    private func deny() async {
        guard let client = model.client else { return }
        working = true
        defer { working = false }
        do {
            try await client.denyWebLogin(request.id, nonce: request.nonce)
            outcome = .denied
        } catch {
            self.error = message(for: error)
        }
    }

    private func message(for error: Error) -> String {
        if let e = error as? APIError, case let .server(status, _) = e {
            switch status {
            case 404: return String(localized: "This sign-in request does not exist anymore. Show a new code on the computer.")
            case 410: return String(localized: "This sign-in request has expired or was already answered.")
            case 403: return String(localized: "That was not the number shown on the computer. The request was denied.")
            default: break
            }
        }
        return model.handle(error) ?? error.localizedDescription
    }
}
