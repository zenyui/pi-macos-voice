// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "picrophone",
    platforms: [
        .macOS(.v13)
    ],
    dependencies: [
        // Local Whisper STT engine (Core ML / Neural Engine). Only used by the
        // `whisper` STT engine; the default `apple` engine has no extra deps.
        .package(url: "https://github.com/argmaxinc/WhisperKit.git", from: "0.9.0"),
        // Hugging Face Hub client — used to fetch the Qwen3-TTS tokenizer repo
        // into our own cache dir (pinned to WhisperKit's resolved version).
        .package(url: "https://github.com/huggingface/swift-transformers.git", exact: "1.1.9"),
    ],
    targets: [
        .executableTarget(
            name: "picrophone",
            dependencies: [
                .product(name: "WhisperKit", package: "WhisperKit"),
                // On-device Qwen3-TTS read-aloud engine (Core ML / ANE).
                .product(name: "TTSKit", package: "WhisperKit"),
                // Hub client for cache-scoped tokenizer downloads.
                .product(name: "Hub", package: "swift-transformers"),
            ],
            path: "Sources/picrophone",
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
