// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "FlowLifeboat",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "flow-lifeboat", targets: ["FlowLifeboat"])],
    targets: [
        .target(name: "LimitLifeboatCore"),
        .executableTarget(name: "FlowLifeboat", dependencies: ["LimitLifeboatCore"]),
        .testTarget(name: "LimitLifeboatCoreTests", dependencies: ["LimitLifeboatCore"]),
        .testTarget(name: "FlowLifeboatTests", dependencies: ["FlowLifeboat", "LimitLifeboatCore"])
    ]
)
