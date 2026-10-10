import AppKit
import Foundation

// Where maxshell is, written into Info.plist by mac/build.sh: the bridge
// (src/sagebridge.js), the Node that runs it, and the PATH of the shell
// that built the app (an app opened from the Finder gets a bare one).
enum Config {
    static func value(_ key: String) -> String? {
        if let v = ProcessInfo.processInfo.environment["SAGE_" + key.uppercased()], !v.isEmpty { return v }
        return Bundle.main.object(forInfoDictionaryKey: key) as? String
    }
    static var root: String { value("MaxshellRoot") ?? (NSHomeDirectory() + "/maxshell") }
    static var node: String { value("NodePath") ?? "/opt/homebrew/bin/node" }
    static var path: String { value("UserPath") ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" }
}

// Runs src/sagebridge.js and keeps the latest state it sent.
@MainActor
final class Sage: ObservableObject {
    @Published var state = SageState.empty
    @Published var problem: String?
    @Published var conversations: [Conversation] = []
    @Published var current: UUID?        // the conversation on screen, which Sage remembers
    @Published var mode: Mode = .chat
    @Published var root: String = NSHomeDirectory()

    private var process: Process?
    private var input: FileHandle?
    private var buffer = Data()
    private var saveTask: Task<Void, Never>?

    init() {
        loadConversations()
        if let saved = UserDefaults.standard.string(forKey: "projectFolder"), FileManager.default.fileExists(atPath: saved) { root = saved }
        // For trying it out: SAGE_MODE, SAGE_ROOT and SAGE_ASK (a first message).
        let env = ProcessInfo.processInfo.environment
        let first = Mode(rawValue: env["SAGE_MODE"] ?? "") ?? .chat
        start(mode: first, root: env["SAGE_ROOT"] ?? (first == .image || first == .video ? mediaFolder() : nil), model: env["SAGE_MODEL"])
        if env["SAGE_RESUME"] != nil, let last = conversations.first { open(last) } // …or the latest conversation
        if let ask = env["SAGE_ASK"] { submit(ask) }
    }

    var shown: [Item] { state.items }

    // --- the bridge ---------------------------------------------------------

    private func launch() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: Config.node)
        p.arguments = [Config.root + "/src/sagebridge.js"]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = Config.path
        env["MAXSHELL_IMAGE_NO_OPEN"] = "1"
        p.environment = env
        p.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
        let inPipe = Pipe(), outPipe = Pipe()
        p.standardInput = inPipe
        p.standardOutput = outPipe
        p.standardError = FileHandle.nullDevice
        outPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            Task { @MainActor in self?.received(data) }
        }
        p.terminationHandler = { [weak self] proc in
            Task { @MainActor in
                guard let self, self.process === proc else { return }
                self.process = nil
                self.problem = "Sage’s bridge stopped (exit \(proc.terminationStatus)). Start a new conversation to try again."
                self.state.status = "error"
            }
        }
        do {
            try p.run()
            process = p
            input = inPipe.fileHandleForWriting
            problem = nil
        } catch {
            problem = "Couldn’t start Sage: \(error.localizedDescription). Is maxshell at \(Config.root) and Node at \(Config.node)?"
        }
    }

    private func received(_ data: Data) {
        guard !data.isEmpty else { return }
        buffer.append(data)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any], let ev = obj["ev"] as? String else { continue }
            if ev == "state", let s = try? JSONDecoder().decode(SageState.self, from: line) {
                state = s
                scheduleSave()
            } else if ev == "error", let text = obj["text"] as? String {
                problem = text
            }
        }
    }

    func send(_ cmd: [String: Any]) {
        if process == nil { launch() }
        guard let input, let data = try? JSONSerialization.data(withJSONObject: cmd) else { return }
        try? input.write(contentsOf: data + Data([0x0A]))
    }

    // --- actions ------------------------------------------------------------

    func start(mode: Mode, root: String? = nil, model: String? = nil) {
        if let root { self.root = root; if mode == .code { UserDefaults.standard.set(root, forKey: "projectFolder") } }
        self.mode = mode
        let id = UUID()
        current = id
        state = SageState.empty
        state.mode = mode.rawValue
        state.root = self.root
        var cmd: [String: Any] = ["op": "open", "id": id.uuidString, "mode": mode.rawValue, "root": mode == .chat ? NSHomeDirectory() : self.root]
        if let model { cmd["model"] = model }
        else if let last = UserDefaults.standard.string(forKey: "model.\(mode == .code ? "code" : "chat")") { cmd["model"] = last }
        send(cmd)
        if let level = UserDefaults.standard.string(forKey: "thinking") { send(["op": "think", "level": level]) }
    }

    func submit(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        send(["op": "submit", "text": t])
    }

    // An earlier conversation, picked up where it left off: Sage is told all
    // of it, so it remembers.
    func open(_ conv: Conversation) {
        guard conv.id != current else { return }
        if state.busy || state.drawing { stop() }
        mode = conv.mode
        if conv.mode != .chat { root = conv.root }
        current = conv.id
        state = SageState.empty
        state.mode = conv.mode.rawValue
        state.root = conv.root
        state.items = conv.items
        let items = (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(conv.items))) ?? []
        var cmd: [String: Any] = ["op": "open", "id": conv.id.uuidString, "mode": conv.mode.rawValue, "root": conv.root, "items": items]
        if let model = conv.model, conv.mode == .chat || conv.mode == .code { cmd["model"] = model }
        send(cmd)
    }

    func answer(_ choice: String) { send(["op": "answer", "choice": choice]) }
    func stop() { send(["op": "stop"]) }
    func load(_ file: String) { send(["op": "load", "file": file]) }

    func setModel(_ key: String) {
        UserDefaults.standard.set(key, forKey: "model.\(mode == .code ? "code" : "chat")")
        send(["op": "model", "key": key])
    }

    func setThinking(_ level: String) {
        UserDefaults.standard.set(level, forKey: "thinking")
        send(["op": "think", "level": level])
    }

    func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Open Project"
        panel.message = "Sage Code works in this folder: it reads files freely, and asks before every change or command."
        panel.directoryURL = URL(fileURLWithPath: root)
        if panel.runModal() == .OK, let url = panel.url { start(mode: .code, root: url.path) }
    }

    func quit() {
        send(["op": "quit"])
        process?.terminate()
    }

    // --- conversations on disk --------------------------------------------

    private var folder: URL {
        let url = ProcessInfo.processInfo.environment["SAGE_DATA"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Sage/Conversations", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    func loadConversations() {
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        conversations = files.filter { $0.pathExtension == "json" }
            .compactMap { try? dec.decode(Conversation.self, from: Data(contentsOf: $0)) }
            .sorted { $0.updated > $1.updated }
    }

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
            self?.saveCurrent()
        }
    }

    private func saveCurrent() {
        guard let id = current, let first = state.items.first(where: { $0.type == "user" })?.text else { return }
        let title = String(first.split(separator: "\n").first ?? Substring(first)).prefix(80)
        let conv = Conversation(id: id, mode: mode, root: state.root, title: String(title), updated: Date(), model: state.model, items: state.items)
        if let i = conversations.firstIndex(where: { $0.id == id }) { conversations[i] = conv } else { conversations.insert(conv, at: 0) }
        conversations.sort { $0.updated > $1.updated }
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        if let data = try? enc.encode(conv) { try? data.write(to: folder.appendingPathComponent("\(id.uuidString).json")) }
    }

    // Conversations are moved to the Trash, never deleted outright.
    func remove(_ conv: Conversation) {
        let url = folder.appendingPathComponent("\(conv.id.uuidString).json")
        try? FileManager.default.trashItem(at: url, resultingItemURL: nil)
        conversations.removeAll { $0.id == conv.id }
        if current == conv.id { start(mode: mode) }
    }
}
