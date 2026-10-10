import AppKit
import SwiftUI

@main
struct SageMain: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var sage = Sage()

    var body: some Scene {
        WindowGroup("Sage", id: "main") {
            ContentView()
                .environmentObject(sage)
                .frame(minWidth: 820, minHeight: 560)
                .onAppear { delegate.sage = sage }
        }
        .windowToolbarStyle(.unified)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Chat") { sage.start(mode: .chat) }.keyboardShortcut("n")
                Button("New Code Session…") { sage.chooseFolder() }.keyboardShortcut("n", modifiers: [.command, .shift])
                Button("New Picture") { sage.start(mode: .image, root: mediaFolder()) }.keyboardShortcut("i", modifiers: [.command, .shift])
                Button("New Video") { sage.start(mode: .video, root: mediaFolder()) }.keyboardShortcut("v", modifiers: [.command, .shift])
            }
            CommandMenu("Sage") {
                Button("Stop") { sage.stop() }.keyboardShortcut(".")
                Button("Change Thinking") {
                    let levels = ["off", "low", "medium", "high"]
                    let now = levels.firstIndex(of: sage.state.thinking ?? "medium") ?? 2
                    sage.setThinking(levels[(now + 1) % levels.count])
                }
                .keyboardShortcut("t")
                .disabled(!sage.state.thinks)
                Divider()
                ForEach(Array(sage.state.models.enumerated()), id: \.offset) { i, m in
                    Button(m.label) { sage.setModel(m.key) }
                        .keyboardShortcut(KeyEquivalent(Character(String(i + 1))))
                        .disabled(!m.ready)
                }
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var sage: Sage?
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated { sage?.quit() }
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        // For checking the look: SAGE_SNAPSHOT=file.png saves the window there every 2 s.
        if let file = ProcessInfo.processInfo.environment["SAGE_SNAPSHOT"] {
            Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
                MainActor.assumeIsolated {
                    guard let w = NSApp.windows.first(where: { $0.isVisible && $0.contentView != nil }), let v = w.contentView?.superview ?? w.contentView,
                          let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return }
                    v.cacheDisplay(in: v.bounds, to: rep)
                    try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: file))
                }
            }
        }
    }
}
