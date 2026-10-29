import Foundation

// What src/sagebridge.js sends: the state of a SageApp, the same one the
// terminal app runs.

struct ModelInfo: Codable, Hashable, Identifiable {
    var key: String
    var label: String
    var blurb: String
    var flag: String
    var ready: Bool
    var thinks: Bool
    var id: String { key }
}

struct DiffRow: Codable, Hashable {
    var kind: String // " ", "+", "-", "…"
    var text: String
    var a: Int?
    var b: Int?
}

struct Diff: Codable, Hashable {
    var rows: [DiffRow]
    var added: Int
    var removed: Int
}

// One transcript item. Its type says which fields matter:
// user, sage, thought, note, tool, image, video.
struct Item: Codable, Hashable {
    var type: String
    var text: String?
    var done: Bool?
    var seconds: Double?
    var tone: String?
    var queued: Bool?
    // tools
    var name: String?
    var title: String?
    var detail: String?
    var state: String?
    var command: String?
    var risky: Bool?
    var output: String?
    var diff: Diff?
    var asking: Bool?
    // pictures and clips
    var prompt: String?
    var size: String?
    var step: Int?
    var total: Int?
    var phase: String?
    var stage: String?
    var segment: Int?
    var segments: Int?
    var detailed: String?
    var unwritten: String?
    var out: String?
    var source: String?
    var error: String?
    var kind: String?
    var length: Double?
    var poster: String?
    var edit: Bool?
    var loaded: Bool?
    var writer: String?
    var searching: String?
}

struct SageState: Codable {
    var mode: String
    var root: String
    var model: String
    var models: [ModelInfo]
    var status: String
    var speed: Double
    var thinking: String?
    var thinks: Bool
    var waiting: Bool
    var drawing: Bool
    var suggestion: String?
    var queued: Bool?            // its question waits for another conversation's answer
    var working: [String]?       // every conversation still at it…
    var asking: [String]?        // …or waiting for your OK
    var items: [Item]

    static let empty = SageState(mode: "chat", root: NSHomeDirectory(), model: "e4b", models: [], status: "loading", speed: 0,
                                 thinking: "medium", thinks: false, waiting: false, drawing: false, suggestion: nil, items: [])

    var busy: Bool { ["thinking", "writing", "waiting", "running", "stopping"].contains(status) }
}

enum Mode: String, CaseIterable, Identifiable, Codable {
    case chat, code, image, video
    var id: String { rawValue }
    var title: String {
        switch self {
        case .chat: return "Chat"
        case .code: return "Code"
        case .image: return "Image"
        case .video: return "Video"
        }
    }
    var symbol: String {
        switch self {
        case .chat: return "bubble.left.and.text.bubble.right"
        case .code: return "chevron.left.forwardslash.chevron.right"
        case .image: return "photo"
        case .video: return "film"
        }
    }
}

// A conversation kept on disk, so the sidebar lists earlier ones.
struct Conversation: Codable, Identifiable, Hashable {
    var id: UUID
    var mode: Mode
    var root: String
    var title: String
    var updated: Date
    var model: String?
    var items: [Item]
}
