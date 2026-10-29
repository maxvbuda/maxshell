import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    @EnvironmentObject var sage: Sage
    @State private var draft = ""
    @State private var search = ""

    var body: some View {
        NavigationSplitView {
            Sidebar(search: $search)
                .navigationSplitViewColumnWidth(min: 220, ideal: 250, max: 340)
        } detail: {
            VStack(spacing: 0) {
                Transcript()
                Composer(draft: $draft)
            }
            .background(Color(nsColor: .textBackgroundColor))
            .toolbar { Toolbar() }
            .navigationTitle(title)
            .navigationSubtitle(subtitle)
            .onDrop(of: [.fileURL], isTargeted: nil) { providers in dropped(providers) }
            // conversations from sage in the terminal show up too
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in sage.loadConversations() }
        }
    }

    var title: String {
        sage.conversations.first { $0.id == sage.current }?.title ?? "Sage " + sage.mode.title
    }

    var subtitle: String {
        if sage.mode == .code { return (sage.state.root as NSString).abbreviatingWithTildeInPath }
        return ""
    }

    // A picture dropped in: image chat changes it; elsewhere its path goes in the message.
    func dropped(_ providers: [NSItemProvider]) -> Bool {
        guard let p = providers.first else { return false }
        _ = p.loadObject(ofClass: URL.self) { url, _ in
            guard let url else { return }
            Task { @MainActor in
                if sage.mode == .image { sage.load(url.path) } else { draft += (draft.isEmpty ? "" : " ") + url.path }
            }
        }
        return true
    }
}

// --- sidebar -----------------------------------------------------------------------

struct Sidebar: View {
    @EnvironmentObject var sage: Sage
    @Binding var search: String

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 2) {
                ForEach(Mode.allCases) { mode in
                    Button { newConversation(mode) } label: {
                        HStack(spacing: 10) {
                            Image(systemName: mode.symbol).frame(width: 18)
                            Text(mode == .chat ? "New chat" : mode == .code ? "New code session" : mode == .image ? "New picture" : "New video")
                            Spacer()
                            if sage.mode == mode && sage.state.items.isEmpty { Circle().fill(Color.accentColor).frame(width: 6, height: 6) }
                        }
                        .padding(.horizontal, 10).padding(.vertical, 7)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(SidebarButton(selected: sage.mode == mode && sage.state.items.isEmpty))
                }
            }
            .padding(.horizontal, 8).padding(.top, 8)

            List(selection: Binding(get: { sage.current }, set: { id in if let c = sage.conversations.first(where: { $0.id == id }) { sage.open(c) } })) {
                ForEach(groups, id: \.0) { group in
                    Section(group.0) {
                        ForEach(group.1) { conv in
                            HStack(spacing: 8) {
                                Image(systemName: conv.mode.symbol).font(.caption).foregroundStyle(.secondary).frame(width: 16)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(conv.title).lineLimit(1)
                                    if conv.mode == .code { Text((conv.root as NSString).lastPathComponent).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                                }
                                Spacer(minLength: 0)
                                // still at it in the background, or waiting for you
                                if (sage.state.asking ?? []).contains(conv.id.uuidString) {
                                    Image(systemName: "hand.raised.fill").font(.caption).foregroundStyle(.orange).help("Waiting for your OK")
                                } else if (sage.state.working ?? []).contains(conv.id.uuidString) {
                                    ProgressView().controlSize(.mini).help("Still working")
                                }
                            }
                            .tag(conv.id)
                            .contextMenu {
                                Button("Move to Trash", role: .destructive) { sage.remove(conv) }
                            }
                        }
                    }
                }
            }
            .listStyle(.sidebar)
            .searchable(text: $search, placement: .sidebar, prompt: "Search conversations")
        }
    }

    var groups: [(String, [Conversation])] {
        let cal = Calendar.current
        let list = sage.conversations.filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) }
        var out: [(String, [Conversation])] = []
        for (name, test) in [("Today", { (d: Date) in cal.isDateInToday(d) }),
                             ("Yesterday", { cal.isDateInYesterday($0) }),
                             ("Last 7 days", { $0 > Date().addingTimeInterval(-7 * 86400) }),
                             ("Earlier", { _ in true })] as [(String, (Date) -> Bool)] {
            let taken = Set(out.flatMap { $0.1.map(\.id) })
            let these = list.filter { !taken.contains($0.id) && test($0.updated) }
            if !these.isEmpty { out.append((name, these)) }
        }
        return out
    }

    func newConversation(_ mode: Mode) {
        if mode == .code { sage.chooseFolder(); return }
        sage.start(mode: mode, root: mode == .image || mode == .video ? mediaFolder() : nil)
    }
}

func mediaFolder() -> String {
    let url = FileManager.default.urls(for: .picturesDirectory, in: .userDomainMask)[0].appendingPathComponent("Sage", isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url.path
}

struct SidebarButton: ButtonStyle {
    let selected: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(RoundedRectangle(cornerRadius: 7).fill(selected ? Color.accentColor.opacity(0.15) : configuration.isPressed ? Color.primary.opacity(0.08) : Color.clear))
            .foregroundStyle(selected ? Color.accentColor : Color.primary)
    }
}

// --- toolbar: status, thinking, model ----------------------------------------------

struct Toolbar: ToolbarContent {
    @EnvironmentObject var sage: Sage

    var body: some ToolbarContent {
        ToolbarItem(placement: .navigation) { StatusPill() }
        ToolbarItemGroup(placement: .primaryAction) {
            if sage.mode == .code {
                Button { sage.chooseFolder() } label: {
                    Label((sage.state.root as NSString).lastPathComponent, systemImage: "folder")
                }
                .help("Open another project folder")
            }
            if sage.state.thinks {
                Menu {
                    Picker("Thinking", selection: Binding(get: { sage.state.thinking ?? "medium" }, set: { sage.setThinking($0) })) {
                        Text("Off — answers straight away").tag("off")
                        Text("Low — a quick think").tag("low")
                        Text("Medium — thinks it through").tag("medium")
                        Text("High — thinks longest").tag("high")
                    }
                    .pickerStyle(.inline)
                } label: {
                    Label("Thinking: \((sage.state.thinking ?? "medium").capitalized)", systemImage: "brain")
                        .labelStyle(.titleAndIcon)
                }
                .help("How much Sage thinks before it answers (⌘T); Low and Medium think only when a question needs it")
            }
            if !sage.state.models.isEmpty {
                Menu {
                    ForEach(sage.state.models) { m in
                        Button { sage.setModel(m.key) } label: {
                            Text(m.key == sage.state.model ? "✓ \(m.label)" : "    \(m.label)")
                            Text(m.ready ? m.blurb : "not set up — sage --\(m.flag) --setup")
                        }
                        .disabled(!m.ready)
                    }
                } label: {
                    Label(sage.state.models.first { $0.key == sage.state.model }?.label ?? "Model", systemImage: "cpu")
                        .labelStyle(.titleAndIcon)
                }
                .help("Pick a model")
            }
        }
    }
}

struct StatusPill: View {
    @EnvironmentObject var sage: Sage
    var body: some View {
        let s = sage.state
        HStack(spacing: 6) {
            if s.status == "error" {
                Circle().fill(Color.red).frame(width: 7, height: 7)
                Text("not running")
            } else if s.status == "ready" && !s.drawing {
                Circle().fill(Color.green).frame(width: 7, height: 7)
                Text(s.speed > 0 ? String(format: "ready · %.1f tok/s", s.speed) : "ready")
            } else {
                ProgressView().controlSize(.mini)
                Text(label(s))
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 10).padding(.vertical, 4)
        .background(Capsule().fill(Color.primary.opacity(0.06)))
    }
    func label(_ s: SageState) -> String {
        switch s.status {
        case "loading": return "waking \(s.models.first { $0.key == s.model }?.label ?? "Sage")…"
        case "thinking": return s.queued == true ? "waiting for your other conversation" : "thinking"
        case "writing": return "writing"
        case "waiting": return "waiting for you"
        case "running": return "running a command"
        case "searching": return "searching the web"
        case "stopping": return "stopping"
        default: return s.drawing ? (s.mode == "video" ? "filming" : "drawing") : s.status
        }
    }
}

// --- transcript ----------------------------------------------------------------------

struct Transcript: View {
    @EnvironmentObject var sage: Sage
    var body: some View {
        let items = sage.shown
        ScrollView {
            if items.isEmpty {
                Welcome().padding(.top, 60)
            } else {
                LazyVStack(alignment: .leading, spacing: 18) {
                    ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                        if !(item.type == "sage" || item.type == "thought") || !(item.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            ItemView(item: item, index: i, live: true)
                        }
                    }
                    if ["thinking", "stopping"].contains(sage.state.status), !showsProgress(items) {
                        HStack(spacing: 10) {
                            Sparkle()
                            Text(sage.state.status == "stopping" ? "Stopping…" : "Thinking…").foregroundStyle(.secondary).shimmering()
                        }
                    }
                    Color.clear.frame(height: 8).id("bottom")
                }
                .padding(.horizontal, 28).padding(.vertical, 22)
                .frame(maxWidth: 820)
                .frame(maxWidth: .infinity)
            }
        }
        .defaultScrollAnchor(.bottom)
    }

    // Whether the last item already shows that Sage is at work.
    func showsProgress(_ items: [Item]) -> Bool {
        guard let last = items.last else { return false }
        if last.type == "thought" && last.done != true && !(last.text ?? "").isEmpty { return true }
        return last.type == "sage" && last.done != true && !(last.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

struct Welcome: View {
    @EnvironmentObject var sage: Sage
    var body: some View {
        VStack(spacing: 18) {
            Sparkle(size: 44)
            Text(heading).font(.largeTitle.weight(.semibold))
            Text(blurb).font(.title3).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 520)
            VStack(spacing: 8) {
                ForEach(examples, id: \.self) { ex in
                    Button { sage.submit(ex) } label: {
                        HStack {
                            Text(ex).multilineTextAlignment(.leading)
                            Spacer()
                            Image(systemName: "arrow.up.right").foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .frame(maxWidth: 520)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.05)))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 8)
            if sage.mode == .code {
                Button { sage.chooseFolder() } label: { Label("Open another folder…", systemImage: "folder") }.buttonStyle(.link)
            }
            Text("Runs entirely on this Mac · private · offline").font(.caption).foregroundStyle(.tertiary).padding(.top, 10)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 30)
    }

    var heading: String {
        switch sage.mode {
        case .chat: return "How can I help?"
        case .code: return "What should we build?"
        case .image: return "What should I draw?"
        case .video: return "What should I film?"
        }
    }
    var blurb: String {
        switch sage.mode {
        case .chat: return "Ask anything — Sage answers on your Mac, with no account and nothing sent anywhere."
        case .code: return "Sage Code reads, writes and edits files in \((sage.state.root as NSString).abbreviatingWithTildeInPath) and runs commands. Every change and command is shown and asked first; replaced files go to the Trash."
        case .image: return "Describe a picture, then change it by talking to it. Drop a picture of yours here to edit it."
        case .video: return "Describe a clip — Sage films it, with sound. Then say how to change it, or “keep going”. It takes about 18 minutes for every 2 seconds."
        }
    }
    var examples: [String] {
        switch sage.mode {
        case .chat: return ["Explain how a refrigerator keeps food cold", "Write a haiku about the sea", "What is the integral of x² from 0 to 3?"]
        case .code: return ["Explain what this project does", "Find and fix a bug", "Add tests for the main module"]
        case .image: return ["a cozy cabin in a snowy forest at night, warm light", "a red panda reading under a cherry tree, watercolor", "a retro poster of a rocket over Mars"]
        case .video: return ["a golden retriever puppy running through sunflowers", "waves crashing on black rocks at sunset, slow motion", "a steam train crossing a snowy bridge"]
        }
    }
}

// --- composer ---------------------------------------------------------------------------

struct Composer: View {
    @EnvironmentObject var sage: Sage
    @Binding var draft: String
    @FocusState private var focused: Bool

    var body: some View {
        let busy = (sage.state.busy || sage.state.drawing)
        VStack(spacing: 6) {
            // Sage's guess at your next message: click it, or Tab in the empty box
            if let s = suggestion {
                HStack {
                    Button { draft = s; focused = true } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "arrow.turn.down.right").font(.caption)
                            Text(s).lineLimit(1)
                            Text("Tab").font(.caption2.bold()).padding(.horizontal, 5).padding(.vertical, 1)
                                .background(RoundedRectangle(cornerRadius: 4).stroke(Color.secondary.opacity(0.5)))
                        }
                        .font(.callout)
                        .padding(.horizontal, 12).padding(.vertical, 6)
                        .background(Capsule().fill(Color.accentColor.opacity(0.1)))
                        .overlay(Capsule().stroke(Color.accentColor.opacity(0.3)))
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .help("Use this suggestion")
                    Spacer()
                }
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            HStack(alignment: .bottom, spacing: 10) {
                if sage.mode == .image {
                    Button { pickPicture() } label: { Image(systemName: "photo.badge.plus").font(.title3) }
                        .buttonStyle(.borderless).help("Change a picture of yours")
                        .padding(.bottom, 4)
                }
                TextField(suggestion ?? placeholder, text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.body)
                    .lineLimit(1...10)
                    .focused($focused)
                    .onSubmit(send)
                    .onKeyPress(.escape) {
                        guard sage.state.waiting else { return .ignored }
                        sage.answer("n")
                        return .handled
                    }
                    .onKeyPress(.tab) {
                        guard draft.isEmpty, let s = suggestion else { return .ignored }
                        draft = s
                        return .handled
                    }
                    .padding(.vertical, 4)
                Button(action: busy ? sage.stop : send) {
                    Image(systemName: busy ? "stop.fill" : "arrow.up")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 28, height: 28)
                        .background(Circle().fill(busy || !draft.isEmpty ? Color.accentColor : Color.secondary.opacity(0.4)))
                }
                .buttonStyle(.plain)
                .help(busy ? "Stop (⌘.)" : "Send (Return)")
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color(nsColor: .controlBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(focused ? Color.accentColor.opacity(0.5) : Color.primary.opacity(0.12)))
            .shadow(color: .black.opacity(0.06), radius: 8, y: 2)
            Text(hint).font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 24).padding(.bottom, 14).padding(.top, 6)
        .frame(maxWidth: 860)
        .frame(maxWidth: .infinity)
        .onAppear { focused = true }
        .animation(.easeOut(duration: 0.2), value: suggestion)
    }

    var suggestion: String? {
        guard draft.isEmpty, !sage.state.busy, let s = sage.state.suggestion, !s.isEmpty else { return nil }
        return s
    }

    var placeholder: String {
        if sage.state.waiting { return "Return or y — yes · a — yes to all · n or Esc — no" }
        switch sage.mode {
        case .chat: return "Ask Sage anything…"
        case .code: return "Tell Sage what to build or fix…"
        case .image: return sage.state.items.contains { $0.type == "image" && $0.state == "done" } ? "Say how to change it…" : "Describe a picture…"
        case .video: return sage.state.items.contains { $0.type == "video" && $0.state == "done" } ? "Say how to change it, or “keep going”…" : "Describe a clip…"
        }
    }

    var hint: String {
        "Return to send · ⌥Return for a new line · /help for commands" + (sage.state.thinks ? " · ⌘T thinking" : "")
    }

    func send() {
        let t = draft
        // Sage is asking about a change or command: the box answers it
        if sage.state.waiting {
            let word = t.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let choice = ["", "y", "yes", "ok", "okay", "sure", "go", "do it"].contains(word) ? "y"
                : ["a", "all", "always", "yes to all"].contains(word) ? "a"
                : ["n", "no", "nope", "stop", "don't"].contains(word) ? "n" : nil
            if let choice { draft = ""; sage.answer(choice) }
            return
        }
        guard !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        if sage.state.busy && !t.hasPrefix("/") { return }
        draft = ""
        sage.submit(t)
    }

    func pickPicture() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        if panel.runModal() == .OK, let url = panel.url { sage.load(url.path) }
    }
}
