import AVKit
import AppKit
import SwiftUI

struct ItemView: View {
    let item: Item
    let index: Int
    let live: Bool
    @EnvironmentObject var sage: Sage

    var body: some View {
        switch item.type {
        case "user": UserMessage(text: item.text ?? "", queued: item.queued == true)
        case "sage": SageMessage(text: item.text ?? "", writing: live && item.done != true && sage.state.status == "writing")
        case "thought": ThoughtView(item: item)
        case "note": NoteView(text: item.text ?? "", error: item.tone == "err")
        case "tool": ToolCard(item: item, live: live)
        case "image": PictureCard(item: item)
        case "video": ClipCard(item: item)
        default: EmptyView()
        }
    }
}

struct UserMessage: View {
    let text: String
    let queued: Bool
    var body: some View {
        HStack {
            Spacer(minLength: 80)
            VStack(alignment: .trailing, spacing: 4) {
                Text(text)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.primary.opacity(0.07)))
                if queued { Text("Sent once Sage is ready").font(.caption).foregroundStyle(.secondary) }
            }
        }
    }
}

struct Sparkle: View {
    var size: CGFloat = 15
    var body: some View {
        Image(systemName: "sparkle")
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(LinearGradient(colors: [Color(red: 0.55, green: 0.45, blue: 1.0), Color(red: 1.0, green: 0.55, blue: 0.35)],
                                            startPoint: .topLeading, endPoint: .bottomTrailing))
    }
}

struct SageMessage: View {
    let text: String
    let writing: Bool
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Sparkle().padding(.top, 2)
            VStack(alignment: .leading, spacing: 0) {
                MarkdownView(text: text.trimmingCharacters(in: .whitespacesAndNewlines))
                if writing { Cursor().padding(.top, 4) }
            }
            Spacer(minLength: 0)
        }
    }
}

struct Cursor: View {
    @State private var on = true
    var body: some View {
        RoundedRectangle(cornerRadius: 1).fill(Color.accentColor).frame(width: 8, height: 15)
            .opacity(on ? 1 : 0.2)
            .onAppear { withAnimation(.easeInOut(duration: 0.6).repeatForever()) { on.toggle() } }
    }
}

// The model's thinking: open while it thinks, folded once it answers.
struct ThoughtView: View {
    let item: Item
    @State private var open: Bool? = nil
    var body: some View {
        let done = item.done == true
        let expanded = open ?? !done
        VStack(alignment: .leading, spacing: 8) {
            Button { open = !expanded } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right").font(.caption.bold()).rotationEffect(.degrees(expanded ? 90 : 0))
                    Image(systemName: "brain").font(.caption)
                    if done { Text("Thought for \(duration(item.seconds ?? 0))") } else { Text("Thinking…").shimmering() }
                }
                .font(.callout).foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded {
                Text((item.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
                    .font(.callout).foregroundStyle(.secondary).lineSpacing(3)
                    .textSelection(.enabled)
                    .padding(.leading, 12)
                    .overlay(alignment: .leading) { Rectangle().fill(Color.secondary.opacity(0.3)).frame(width: 2) }
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.leading, 27)
    }
}

func duration(_ s: Double) -> String {
    let n = Int(s.rounded())
    return n >= 60 ? "\(n / 60)m \(n % 60)s" : "\(max(1, n))s"
}

struct Shimmer: ViewModifier {
    @State private var phase: CGFloat = -1
    func body(content: Content) -> some View {
        content.overlay(
            LinearGradient(colors: [.clear, .white.opacity(0.5), .clear], startPoint: .leading, endPoint: .trailing)
                .offset(x: phase * 120).blendMode(.plusLighter).mask(content)
        )
        .onAppear { withAnimation(.linear(duration: 1.4).repeatForever(autoreverses: false)) { phase = 1.5 } }
    }
}
extension View { func shimmering() -> some View { modifier(Shimmer()) } }

struct NoteView: View {
    let text: String
    let error: Bool
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: error ? "exclamationmark.triangle.fill" : "info.circle").foregroundStyle(error ? .red : .secondary)
            Text(text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
        .font(.callout)
        .foregroundStyle(error ? Color.red : Color.secondary)
        .padding(.leading, 27)
    }
}

// --- Sage Code's tools ----------------------------------------------------------

struct ToolCard: View {
    let item: Item
    let live: Bool
    @EnvironmentObject var sage: Sage
    @State private var showOutput = false

    var icon: String {
        switch item.name {
        case "list_files": return "folder"
        case "read_file": return "doc.text"
        case "search_files": return "magnifyingglass"
        case "write_file": return "doc.badge.plus"
        case "edit_file": return "pencil"
        case "run_command": return "terminal"
        default: return "wrench"
        }
    }

    var body: some View {
        let asking = live && item.asking == true
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: icon).frame(width: 16).foregroundStyle(.secondary)
                Text(item.title ?? item.name ?? "tool")
                    .font(.system(.callout, design: item.command != nil ? .monospaced : .default).weight(.medium))
                    .lineLimit(2).truncationMode(.middle)
                if item.risky == true {
                    Text("careful").font(.caption2.bold()).padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Capsule().fill(Color.orange.opacity(0.2))).foregroundStyle(.orange)
                }
                Spacer()
                if let d = item.detail, !d.isEmpty, item.state != "ask" { Text(d).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                StateBadge(state: item.state ?? "")
            }
            .padding(.horizontal, 12).padding(.vertical, 9)

            if let diff = item.diff, !diff.rows.isEmpty {
                Divider()
                DiffView(diff: diff)
            }
            if let out = item.output, !out.isEmpty {
                Divider()
                DisclosureGroup(isExpanded: $showOutput) {
                    LeadingScroll {
                        Text(out).font(.system(size: 11.5, design: .monospaced)).textSelection(.enabled).padding(8)
                    }
                    .frame(maxHeight: 260)
                } label: { Text("Output").font(.caption).foregroundStyle(.secondary) }
                .padding(.horizontal, 12).padding(.vertical, 6)
            }
            if asking { Divider(); ApprovalBar(command: item.command != nil, risky: item.risky == true) }
        }
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(asking ? Color.accentColor.opacity(0.7) : Color.primary.opacity(0.1), lineWidth: asking ? 1.5 : 1))
        .padding(.leading, 27)
    }
}

struct StateBadge: View {
    let state: String
    var body: some View {
        switch state {
        case "ok": Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case "fail": Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
        case "running": ProgressView().controlSize(.small)
        case "declined": Text("declined").font(.caption).foregroundStyle(.secondary)
        case "ask": Text("needs your OK").font(.caption.bold()).foregroundStyle(Color.accentColor)
        default: EmptyView()
        }
    }
}

struct ApprovalBar: View {
    let command: Bool
    let risky: Bool
    @EnvironmentObject var sage: Sage
    var body: some View {
        HStack(spacing: 8) {
            Text(command ? "Run this command?" : "Make this change?").font(.callout.weight(.medium))
            Spacer()
            Button("No") { sage.answer("n") }.keyboardShortcut(.cancelAction)
            if !risky {
                Button(command ? "Yes, don’t ask for commands" : "Yes to all changes") { sage.answer("a") }
                    .keyboardShortcut(.return, modifiers: .command)
            }
            Button("Yes") { sage.answer("y") }.keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Color.accentColor.opacity(0.06))
    }
}

// Scrolls both ways, with its content at the top left (not centred).
struct LeadingScroll<Content: View>: View {
    @ViewBuilder let content: () -> Content
    @State private var width: CGFloat = 0
    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            content().frame(minWidth: width, alignment: .leading)
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }
}

struct DiffView: View {
    let diff: Diff
    var body: some View {
        LeadingScroll {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(diff.rows.enumerated()), id: \.offset) { _, row in
                    if row.kind == "…" {
                        Text("⋯").foregroundStyle(.secondary).padding(.leading, 70).frame(height: 18)
                    } else {
                        HStack(spacing: 0) {
                            Text(row.kind == "+" ? "" : row.a.map(String.init) ?? "").frame(width: 34, alignment: .trailing)
                            Text(row.kind == "-" ? "" : row.b.map(String.init) ?? "").frame(width: 34, alignment: .trailing)
                            Text(row.kind == " " ? " " : row.kind).frame(width: 18).foregroundStyle(color(row.kind))
                            Text(row.text.isEmpty ? " " : row.text).foregroundStyle(row.kind == " " ? Color.primary.opacity(0.75) : Color.primary)
                            Spacer(minLength: 0)
                        }
                        .foregroundStyle(.secondary)
                        .padding(.trailing, 12)
                        .frame(minHeight: 18)
                        .background(color(row.kind).opacity(row.kind == " " ? 0 : 0.13))
                    }
                }
            }
            .font(.system(size: 11.5, design: .monospaced))
            .padding(.vertical, 6)
        }
        .frame(maxHeight: 360)
    }
    func color(_ k: String) -> Color { k == "+" ? .green : k == "-" ? .red : .secondary }
}

// --- pictures and clips ---------------------------------------------------------

struct PictureCard: View {
    let item: Item
    var body: some View {
        MediaCard(item: item, noun: "Picture") {
            if let out = item.out, item.state == "done", let image = NSImage(contentsOfFile: out) {
                Image(nsImage: image).resizable().aspectRatio(contentMode: .fit)
                    .frame(maxWidth: 560, maxHeight: 560)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .onDrag { NSItemProvider(contentsOf: URL(fileURLWithPath: out)) ?? NSItemProvider() }
                    .contextMenu { FileMenu(path: out) }
            }
        }
    }
}

struct ClipCard: View {
    let item: Item
    var body: some View {
        MediaCard(item: item, noun: item.kind == "extend" ? "Longer clip" : item.kind == "refilm" ? "New version" : "Clip") {
            if let out = item.out, item.state == "done" {
                ClipPlayer(path: out)
                    .aspectRatio(16.0 / 9.0, contentMode: .fit)
                    .frame(maxWidth: 640)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .contextMenu { FileMenu(path: out) }
            } else if let poster = item.poster, let image = NSImage(contentsOfFile: poster) {
                Image(nsImage: image).resizable().aspectRatio(contentMode: .fit).frame(maxWidth: 420)
                    .clipShape(RoundedRectangle(cornerRadius: 10)).opacity(0.85)
            }
        }
    }
}

// One player per clip, made once (the card redraws as the state updates).
struct ClipPlayer: View {
    let path: String
    @State private var player: AVPlayer?
    var body: some View {
        VideoPlayer(player: player)
            .onAppear { if player == nil { player = AVPlayer(url: URL(fileURLWithPath: path)) } }
    }
}

struct FileMenu: View {
    let path: String
    var body: some View {
        Button("Open") { NSWorkspace.shared.open(URL(fileURLWithPath: path)) }
        Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
        Button("Copy Path") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(path, forType: .string) }
    }
}

struct MediaCard<Content: View>: View {
    let item: Item
    let noun: String
    @ViewBuilder let content: () -> Content
    @State private var showPrompt = false

    var status: String {
        switch item.state {
        case "done": return item.loaded == true ? "Your picture" : "Done in \(duration(item.seconds ?? 0))"
        case "failed": return item.error ?? "Failed"
        case "stopped": return "Stopped"
        default:
            if item.phase == "prompt" { return "\(item.writer ?? "Sage") is writing a detailed prompt…" }
            if item.stage == "sound" { return "Adding sound…" }
            if item.stage == "decode" { return "Decoding…" }
            let part = (item.segments ?? 1) > 1 ? "part \(item.segment ?? 1)/\(item.segments ?? 1) · " : ""
            return "\(part)step \(item.step ?? 0) of \(item.total ?? 0)"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(noun).font(.callout.weight(.semibold))
                if let size = item.size { Text(size).font(.caption).foregroundStyle(.secondary) }
                if let len = item.length { Text("\(Int(len)) s").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Text(status).font(.caption).foregroundStyle(item.state == "failed" ? .red : .secondary).lineLimit(2)
            }
            if item.state == "running" {
                if item.phase == "prompt" || (item.total ?? 0) == 0 { ProgressView().progressViewStyle(.linear) }
                else { ProgressView(value: Double(item.step ?? 0), total: Double(max(1, item.total ?? 1))) }
            }
            content()
            if let d = item.detailed, !d.isEmpty {
                DisclosureGroup(isExpanded: $showPrompt) {
                    Text(d).font(.callout).foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                } label: { Text("Sage’s prompt").font(.caption).foregroundStyle(.secondary) }
            }
            if let out = item.out, item.state == "done" {
                HStack {
                    Text((out as NSString).abbreviatingWithTildeInPath).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    Button { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: out)]) } label: { Image(systemName: "folder") }
                        .buttonStyle(.borderless).help("Show in Finder")
                }
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.primary.opacity(0.1)))
        .padding(.leading, 27)
    }
}
