// swift-tools-version:6.0
// Sage for Mac: a SwiftUI app for Sage, built with SwiftPM alone (no Xcode
// project) by mac/build.sh.
import PackageDescription

let package = Package(
    name: "Sage",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(name: "Sage", path: "Sources/Sage"),
    ],
    swiftLanguageModes: [.v5]
)
