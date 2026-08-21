import AppKit
import Foundation

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var workers: [Process] = []

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    launchWorker()
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    launchWorker()
    return false
  }

  private func launchWorker() {
    guard let workerPath = Bundle.main.path(forResource: "Codex Quota Injector Worker", ofType: nil) else {
      NSApp.terminate(nil)
      return
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: workerPath)
    var environment = ProcessInfo.processInfo.environment
    environment["CODEX_QUOTA_EXPLICIT_START"] = "1"
    process.environment = environment
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    process.terminationHandler = { [weak self] terminatedProcess in
      DispatchQueue.main.async {
        guard let self else { return }
        self.workers.removeAll { $0 === terminatedProcess }
        if self.workers.isEmpty {
          NSApp.terminate(nil)
        }
      }
    }
    workers.append(process)
    do {
      try process.run()
    } catch {
      workers.removeAll { $0 === process }
      if workers.isEmpty {
        NSApp.terminate(nil)
      }
    }
  }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.run()
