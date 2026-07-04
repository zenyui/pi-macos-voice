// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "swyft",
    platforms: [
        .macOS(.v13)
    ],
    targets: [
        .executableTarget(
            name: "swyft",
            path: "Sources/swyft",
            linkerSettings: [
                // Embed Info.plist into the Mach-O so TCC can read usage strings
                // and the binary has a bundle identity without a full .app wrapper.
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Info.plist",
                ])
            ]
        )
    ]
)
