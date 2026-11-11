import AVFoundation
import SwiftUI

struct OnboardingView: View {
    @Environment(AppModel.self) private var model
    // Self-hosted: no default server. QR pairing links carry the server; email sign-in needs it typed in.
    @State private var serverText = ""
    @State private var email = ""
    @State private var password = ""
    @State private var working = false
    @State private var error: String?
    @State private var scanning = false
    @State private var showServer = true
    @FocusState private var focus: Field?

    private enum Field { case server, email, password }

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                VStack(spacing: 14) {
                    BrandMark(size: 92)
                        .padding(.top, 48)
                    Text("Revflare").font(.largeTitle.bold())
                    Text("All your App Store revenue, live.")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }

                VStack(spacing: 12) {
                    Button {
                        error = nil
                        scanning = true
                    } label: {
                        Label("Scan QR code", systemImage: "qrcode.viewfinder")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.glassProminent)
                    .controlSize(.large)
                    Text("In the web app, open Settings → iOS app and scan the code.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }

                HStack {
                    Rectangle().fill(.quaternary).frame(height: 1)
                    Text("or").font(.footnote).foregroundStyle(.secondary)
                    Rectangle().fill(.quaternary).frame(height: 1)
                }

                VStack(spacing: 12) {
                    DisclosureGroup(isExpanded: $showServer) {
                        TextField("https://revflare.example.com", text: $serverText)
                            .textContentType(.URL)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($focus, equals: .server)
                            .padding(12)
                            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
                            .padding(.top, 8)
                    } label: {
                        HStack {
                            Label("Server", systemImage: "server.rack")
                            Spacer()
                            Text(APIClient.normalizeServer(serverText)?.host() ?? "—").foregroundStyle(.secondary).lineLimit(1)
                        }
                        .font(.subheadline)
                    }
                    .tint(.primary)

                    TextField("Email", text: $email)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .email)
                        .submitLabel(.next)
                        .onSubmit { focus = .password }
                        .padding(14)
                        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .focused($focus, equals: .password)
                        .submitLabel(.go)
                        .onSubmit { Task { await signIn() } }
                        .padding(14)
                        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))

                    if let error {
                        Label(error, systemImage: "exclamationmark.circle.fill")
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    Button {
                        Task { await signIn() }
                    } label: {
                        Group {
                            if working { ProgressView() } else { Text("Sign in").font(.headline) }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                    }
                    .buttonStyle(.glass)
                    .controlSize(.large)
                    .disabled(working || serverText.isEmpty || email.isEmpty || password.isEmpty)
                }
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 32)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(
            LinearGradient(colors: [Color.brand.opacity(0.18), Color(.systemGroupedBackground)], startPoint: .top, endPoint: .center)
                .ignoresSafeArea()
        )
        .sheet(isPresented: $scanning) {
            QRScannerSheet { code in
                scanning = false
                if let url = URL(string: code), let request = AppModel.PairRequest(url: url) {
                    Task { await pair(request) }
                } else if let url = URL(string: code), AppModel.WebLoginRequest(url: url) != nil {
                    error = String(localized: "This code signs a computer in with the app. Sign in to the app first, then scan it from Settings.")
                } else {
                    error = String(localized: "This is not a Revflare sign-in code.")
                }
            }
        }
        .onChange(of: model.pendingPair) { _, request in
            if let request {
                model.pendingPair = nil
                Task { await pair(request) }
            }
        }
        .onAppear {
            if let request = model.pendingPair {
                model.pendingPair = nil
                Task { await pair(request) }
            }
        }
    }

    private func signIn() async {
        guard let server = APIClient.normalizeServer(serverText) else {
            error = String(localized: "Enter a valid server address.")
            return
        }
        working = true
        defer { working = false }
        do {
            try await model.signIn(server: server, email: email.trimmingCharacters(in: .whitespaces), password: password)
        } catch {
            self.error = message(for: error)
        }
    }

    private func pair(_ request: AppModel.PairRequest) async {
        serverText = request.server.absoluteString
        working = true
        defer { working = false }
        do {
            try await model.pair(server: request.server, code: request.code)
        } catch {
            self.error = message(for: error)
        }
    }

    private func message(for error: Error) -> String {
        if let e = error as? APIError, case .unauthorized = e { return String(localized: "Wrong email or password, or the code has expired.") }
        return error.localizedDescription
    }
}

/// Camera QR scanner for `revflare://` codes: pairing (`pair?...`) and web sign-in requests (`web-login?...`).
struct QRScannerSheet: View {
    @Environment(\.dismiss) private var dismiss
    var hint: LocalizedStringKey = "Point the camera at the QR code in the Revflare web app."
    var onCode: (String) -> Void
    @State private var denied = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                if denied {
                    ContentUnavailableView {
                        Label("Camera access needed", systemImage: "camera")
                    } description: {
                        Text("Allow camera access in Settings to scan the sign-in code.")
                    } actions: {
                        Button("Open Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                        }
                        .buttonStyle(.glassProminent)
                    }
                    .foregroundStyle(.white)
                } else {
                    QRScannerView(onCode: onCode).ignoresSafeArea()
                    RoundedRectangle(cornerRadius: 28, style: .continuous)
                        .strokeBorder(.white.opacity(0.9), lineWidth: 3)
                        .frame(width: 250, height: 250)
                    VStack {
                        Spacer()
                        Text(hint)
                            .font(.subheadline)
                            .foregroundStyle(.white)
                            .multilineTextAlignment(.center)
                            .padding()
                            .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 18))
                            .padding(24)
                    }
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task {
                switch AVCaptureDevice.authorizationStatus(for: .video) {
                case .notDetermined:
                    denied = !(await AVCaptureDevice.requestAccess(for: .video))
                case .denied, .restricted:
                    denied = true
                default:
                    break
                }
            }
        }
    }
}

struct QRScannerView: UIViewControllerRepresentable {
    var onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let vc = ScannerController()
        vc.onCode = onCode
        return vc
    }

    func updateUIViewController(_ vc: ScannerController, context: Context) {}

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: ((String) -> Void)?
        private let session = AVCaptureSession()
        private var preview: AVCaptureVideoPreviewLayer?
        private var delivered = false

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else { return }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            view.layer.addSublayer(layer)
            preview = layer
            let session = self.session
            DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            let session = self.session
            DispatchQueue.global(qos: .userInitiated).async { session.stopRunning() }
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard !delivered, let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject, let value = obj.stringValue,
                  value.lowercased().hasPrefix("revflare://") else { return }
            delivered = true
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onCode?(value)
        }
    }
}
