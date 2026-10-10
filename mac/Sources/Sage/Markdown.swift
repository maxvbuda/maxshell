import AppKit
import SwiftUI

// Sage's answers as rich text: headings, paragraphs, lists, quotes, tables,
// rules and code blocks (highlighted, with a copy button). Inline styles
// come from Foundation's Markdown parser. Math is already Unicode (the
// bridge converts TeX the way the terminal does).

enum Block: Hashable {
    case heading(Int, String)
    case paragraph(String)
    case list([ListEntry])
    case quote(String)
    case code(String, String)
    case table([[String]])
    case rule
}

struct ListEntry: Hashable {
    var marker: String // "•" or "3."
    var indent: Int
    var text: String
}

func parseMarkdown(_ src: String) -> [Block] {
    var blocks: [Block] = []
    let lines = src.replacingOccurrences(of: "\r", with: "").components(separatedBy: "\n")
    var i = 0
    var para: [String] = []
    func flush() {
        if !para.isEmpty { blocks.append(.paragraph(para.joined(separator: "\n"))); para = [] }
    }
    let listRe = try! NSRegularExpression(pattern: #"^(\s*)([-*+]|\d+[.)])\s+(.*)$"#)
    func listMatch(_ l: String) -> ListEntry? {
        let ns = l as NSString
        guard let m = listRe.firstMatch(in: l, range: NSRange(location: 0, length: ns.length)) else { return nil }
        let marker = ns.substring(with: m.range(at: 2))
        return ListEntry(marker: marker.first!.isNumber ? marker.replacingOccurrences(of: ")", with: ".") : "•",
                         indent: ns.substring(with: m.range(at: 1)).count / 2, text: ns.substring(with: m.range(at: 3)))
    }
    while i < lines.count {
        let line = lines[i]
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("```") {
            flush()
            let lang = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            var code: [String] = []
            i += 1
            while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") { code.append(lines[i]); i += 1 }
            blocks.append(.code(lang, code.joined(separator: "\n")))
            i += 1
            continue
        }
        if trimmed.isEmpty { flush(); i += 1; continue }
        if let m = trimmed.range(of: #"^#{1,6}\s"#, options: .regularExpression) {
            flush()
            let level = trimmed[m].filter { $0 == "#" }.count
            blocks.append(.heading(level, String(trimmed[m.upperBound...])))
            i += 1
            continue
        }
        if trimmed.range(of: #"^([-*_])(\s*\1){2,}$"#, options: .regularExpression) != nil {
            flush(); blocks.append(.rule); i += 1; continue
        }
        if trimmed.hasPrefix(">") {
            flush()
            var q: [String] = []
            while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                q.append(String(lines[i].trimmingCharacters(in: .whitespaces).dropFirst()).trimmingCharacters(in: .whitespaces)); i += 1
            }
            blocks.append(.quote(q.joined(separator: "\n")))
            continue
        }
        if trimmed.hasPrefix("|"), i + 1 < lines.count, lines[i + 1].range(of: #"^\s*\|?\s*:?-{2,}"#, options: .regularExpression) != nil {
            flush()
            var rows: [[String]] = []
            func cells(_ l: String) -> [String] {
                var t = l.trimmingCharacters(in: .whitespaces)
                if t.hasPrefix("|") { t.removeFirst() }
                if t.hasSuffix("|") { t.removeLast() }
                return t.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
            }
            rows.append(cells(line))
            i += 2
            while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("|") { rows.append(cells(lines[i])); i += 1 }
            blocks.append(.table(rows))
            continue
        }
        if listMatch(line) != nil {
            flush()
            var entries: [ListEntry] = []
            while i < lines.count {
                if let e = listMatch(lines[i]) { entries.append(e); i += 1 }
                else if !lines[i].trimmingCharacters(in: .whitespaces).isEmpty, lines[i].hasPrefix("  "), !entries.isEmpty {
                    entries[entries.count - 1].text += " " + lines[i].trimmingCharacters(in: .whitespaces); i += 1
                } else { break }
            }
            blocks.append(.list(entries))
            continue
        }
        para.append(line)
        i += 1
    }
    flush()
    return blocks
}

func inline(_ s: String) -> AttributedString {
    let opts = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
    var a = (try? AttributedString(markdown: s, options: opts)) ?? AttributedString(s)
    for run in a.runs where run.inlinePresentationIntent?.contains(.code) == true {
        a[run.range].font = .system(.body, design: .monospaced)
        a[run.range].backgroundColor = Color.primary.opacity(0.07)
    }
    return a
}

struct MarkdownView: View {
    let text: String
    var body: some View {
        let blocks = parseMarkdown(text)
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                BlockView(block: block)
            }
        }
        .textSelection(.enabled)
    }
}

struct BlockView: View {
    let block: Block
    var body: some View {
        switch block {
        case .heading(let level, let t):
            Text(inline(t))
                .font(level == 1 ? .title2.bold() : level == 2 ? .title3.bold() : .headline)
                .padding(.top, level <= 2 ? 6 : 2)
        case .paragraph(let t):
            Text(inline(t)).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
        case .list(let entries):
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(entries.enumerated()), id: \.offset) { _, e in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(e.marker).foregroundStyle(.secondary).monospacedDigit()
                            .frame(minWidth: 14, alignment: .trailing)
                        Text(inline(e.text)).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.leading, CGFloat(e.indent) * 18)
                }
            }
        case .quote(let t):
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 1.5).fill(Color.accentColor.opacity(0.6)).frame(width: 3)
                Text(inline(t)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        case .code(let lang, let code):
            CodeBlock(language: lang, code: code)
        case .table(let rows):
            TableBlock(rows: rows)
        case .rule:
            Divider().padding(.vertical, 4)
        }
    }
}

struct TableBlock: View {
    let rows: [[String]]
    var body: some View {
        let cols = rows.map(\.count).max() ?? 0
        Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { r, row in
                GridRow {
                    ForEach(0..<cols, id: \.self) { c in
                        Text(inline(c < row.count ? row[c] : ""))
                            .fontWeight(r == 0 ? .semibold : .regular)
                            .padding(.horizontal, 10).padding(.vertical, 6)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(r == 0 ? Color.primary.opacity(0.06) : Color.clear)
                    }
                }
                if r < rows.count - 1 { Divider() }
            }
        }
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.primary.opacity(0.12)))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

struct CodeBlock: View {
    let language: String
    let code: String
    @State private var copied = false
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? "code" : language).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(code, forType: .string)
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc").font(.caption)
                }
                .buttonStyle(.borderless)
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(Color.primary.opacity(0.05))
            ScrollView(.horizontal, showsIndicators: false) {
                Text(highlight(code, language: language))
                    .font(.system(size: 12.5, design: .monospaced))
                    .lineSpacing(2)
                    .padding(12)
                    .fixedSize(horizontal: true, vertical: true)
            }
        }
        .background(Color.primary.opacity(0.035))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.primary.opacity(0.1)))
    }
}

// A light highlighter good enough for most languages: comments, strings,
// numbers and common keywords.
private let keywords: Set<String> = [
    "def", "class", "return", "if", "elif", "else", "for", "while", "in", "import", "from", "as", "with", "try", "except",
    "finally", "raise", "lambda", "yield", "pass", "break", "continue", "and", "or", "not", "is", "None", "True", "False",
    "function", "const", "let", "var", "new", "this", "async", "await", "export", "default", "switch", "case", "throw",
    "catch", "typeof", "instanceof", "null", "undefined", "true", "false", "struct", "enum", "func", "guard", "self",
    "public", "private", "static", "fn", "mut", "impl", "pub", "use", "match", "int", "void", "char", "float", "double",
    "bool", "string", "package", "go", "defer", "interface", "type", "extends", "implements", "then", "fi", "do", "done", "echo",
]

func highlight(_ code: String, language: String) -> AttributedString {
    var out = AttributedString()
    let hashComments = ["py", "python", "sh", "bash", "zsh", "shell", "ruby", "rb", "yaml", "yml", "toml", "r", ""].contains(language.lowercased())
    let pattern = #"(//[^\n]*|/\*[\s\S]*?\*/"# + (hashComments ? #"|#[^\n]*"# : "") + #")|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)"#
    let re = try! NSRegularExpression(pattern: pattern)
    let ns = code as NSString
    var last = 0
    let comment = Color(nsColor: .systemGray), string = Color(nsColor: .systemGreen), number = Color(nsColor: .systemOrange), keyword = Color(nsColor: .systemPurple)
    for m in re.matches(in: code, range: NSRange(location: 0, length: ns.length)) {
        if m.range.location > last { out += AttributedString(ns.substring(with: NSRange(location: last, length: m.range.location - last))) }
        var piece = AttributedString(ns.substring(with: m.range))
        if m.range(at: 1).location != NSNotFound { piece.foregroundColor = comment }
        else if m.range(at: 2).location != NSNotFound { piece.foregroundColor = string }
        else if m.range(at: 3).location != NSNotFound { piece.foregroundColor = number }
        else if keywords.contains(ns.substring(with: m.range)) { piece.foregroundColor = keyword }
        out += piece
        last = m.range.location + m.range.length
    }
    if last < ns.length { out += AttributedString(ns.substring(from: last)) }
    return out
}
