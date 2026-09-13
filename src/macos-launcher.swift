import AppKit
import Foundation

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var workers: [Process] = []

  private var logPath: String {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Logs/Codex Quota Injector/injector.log").path
  }

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
      showStartupFailure("正式包缺少启动 Worker。")
      NSApp.terminate(nil)
      return
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: workerPath)
    process.arguments = ["--explicit-start"]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    process.terminationHandler = { [weak self] terminatedProcess in
      DispatchQueue.main.async {
        guard let self else { return }
        self.workers.removeAll { $0 === terminatedProcess }
        if terminatedProcess.terminationReason == .exit &&
           terminatedProcess.terminationStatus != 0 {
          self.showStartupFailure("启动进程异常退出（状态码 \(terminatedProcess.terminationStatus)）。")
        }
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
      showStartupFailure("无法启动 Worker：\(error.localizedDescription)")
      if workers.isEmpty {
        NSApp.terminate(nil)
      }
    }
  }

  private func showStartupFailure(_ reason: String) {
    NSApp.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.alertStyle = .critical
    alert.messageText = "Codex Quota Injector 启动失败"
    alert.informativeText = "\(reason)\n\n请查看日志：\n\(logPath)"
    alert.addButton(withTitle: "知道了")
    alert.runModal()
  }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.run()
