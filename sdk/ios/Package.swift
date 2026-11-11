// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "RevflareKit",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "RevflareKit", targets: ["RevflareKit"]),
    ],
    targets: [
        .target(name: "RevflareKit"),
        .testTarget(name: "RevflareKitTests", dependencies: ["RevflareKit"]),
    ],
    swiftLanguageModes: [.v6]
)
