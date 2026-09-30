// sleepwatch — makes mx2's training sleep-safe.
//
//   sleepwatch <training pid> <log file> <ack file>
//
// It registers with IOKit's power management, so macOS waits for it before
// sleeping. When the Mac is about to sleep (lid closed, Sleep menu, idle), it
// sends SIGUSR1 to the trainer, which saves a checkpoint and writes the ack
// file; only then (or after 25 seconds) does it let the Mac sleep. While
// asleep every process is frozen; on wake, training simply carries on. Both
// events go into the training log so `ai --status` can show them.
import Foundation
import IOKit.pwr_mgt

// State lives in an enum so the C callback below captures nothing.
enum W {
    static var pid: Int32 = 0
    static var logPath = ""
    static var ackPath = ""
    static var rootPort: io_connect_t = 0
}

let args = CommandLine.arguments
guard args.count >= 4, let pid = Int32(args[1]) else {
    FileHandle.standardError.write("usage: sleepwatch <pid> <log> <ack>\n".data(using: .utf8)!)
    exit(2)
}
W.pid = pid
W.logPath = args[2]
W.ackPath = args[3]

func log(_ line: String) {
    let logPath = W.logPath
    let f = DateFormatter()
    f.dateFormat = "HH:mm"
    guard let data = "  \(line) (\(f.string(from: Date())))\n".data(using: .utf8) else { return }
    if let handle = FileHandle(forWritingAtPath: logPath) {
        handle.seekToEndOfFile()
        handle.write(data)
        handle.closeFile()
    }
}


var notifier: io_object_t = 0
var notifyPort: IONotificationPortRef?

let callback: IOServiceInterestCallback = { _, _, messageType, messageArgument in
    let id = Int(bitPattern: messageArgument)
    let ackPath = W.ackPath
    switch messageType {
    case 0xe000_0270: // can system sleep
        IOAllowPowerChange(W.rootPort, id)
    case 0xe000_0280: // system will sleep
        log("⏸ Mac going to sleep — saving and pausing")
        try? FileManager.default.removeItem(atPath: ackPath)
        if kill(W.pid, SIGUSR1) == 0 {
            let deadline = Date().addingTimeInterval(25)
            while Date() < deadline && !FileManager.default.fileExists(atPath: ackPath) {
                Thread.sleep(forTimeInterval: 0.2)
            }
            log(FileManager.default.fileExists(atPath: ackPath) ? "  progress saved" : "  (save took too long; the last checkpoint will be used)")
        }
        IOAllowPowerChange(W.rootPort, id)
    case 0xe000_0300: // system has powered on
        log("▶ Mac awake — training resumed")
    default:
        break
    }
}

W.rootPort = IORegisterForSystemPower(nil, &notifyPort, callback, &notifier)
guard W.rootPort != 0, let port = notifyPort else {
    FileHandle.standardError.write("sleepwatch: can't register for power events\n".data(using: .utf8)!)
    exit(1)
}
CFRunLoopAddSource(CFRunLoopGetCurrent(), IONotificationPortGetRunLoopSource(port).takeUnretainedValue(), .defaultMode)

// Quit when the trainer is gone.
Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { _ in
    if kill(pid, 0) != 0 { exit(0) }
}
RunLoop.main.run()
