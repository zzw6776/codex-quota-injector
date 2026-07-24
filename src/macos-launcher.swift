import AppKit
import Foundation

final class AppDelegate: NSObject, NSApplicationDelegate {
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
      return
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: workerPath)
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try? process.run()
  }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.run()
