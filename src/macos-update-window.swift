import AppKit
import WebKit
import Foundation

struct SavedWindowSize: Codable {
  let version: Int
  let width: Double
  let height: Double
}

final class UpdateWindow: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate {
  private var window: NSWindow!
  private var webView: WKWebView!
  private var focusSignal: DispatchSourceSignal?
  private let url: URL
  private let sizePath: URL?
  init(url: URL, sizePath: URL?) { self.url = url; self.sizePath = sizePath; super.init() }
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 510),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.contentMinSize = NSSize(width: 420, height: 460)
    restoreSize()
    window.title = "Codex Quota Injector 更新"
    window.delegate = self
    window.center()
    webView = WKWebView(frame: window.contentView!.bounds)
    webView.autoresizingMask = [.width, .height]
    webView.navigationDelegate = self
    window.contentView!.addSubview(webView)
    webView.load(URLRequest(url: url))
    signal(SIGUSR1, SIG_IGN)
    focusSignal = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
    focusSignal?.setEventHandler { [weak self] in self?.show() }
    focusSignal?.resume()
    show()
  }
  private func show() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
  private func restoreSize() {
    guard let path = sizePath,
      let data = try? Data(contentsOf: path),
      let size = try? JSONDecoder().decode(SavedWindowSize.self, from: data),
      size.version == 1, size.width.isFinite, size.height.isFinite,
      size.width > 0, size.height > 0 else { return }
    let screen = NSScreen.main?.visibleFrame.size ?? NSSize(width: size.width, height: size.height + 32)
    window.setContentSize(NSSize(
      width: max(420, min(size.width, screen.width)),
      height: max(460, min(size.height, screen.height - 32))))
  }
  private func saveSize() {
    guard let path = sizePath, !window.isMiniaturized, !window.isZoomed,
      !window.styleMask.contains(.fullScreen) else { return }
    let size = window.contentView!.bounds.size
    do {
      let data = try JSONEncoder().encode(SavedWindowSize(version: 1, width: size.width, height: size.height))
      try data.write(to: path, options: .atomic)
    } catch { fputs("[update-window] 保存窗口大小失败：\(error.localizedDescription)\n", stderr) }
  }
  func windowDidEndLiveResize(_ notification: Notification) { saveSize() }
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    saveSize()
    var request = URLRequest(url: url.appendingPathComponent("close"))
    request.httpMethod = "POST"
    URLSession.shared.dataTask(with: request) { _, response, _ in
      if (response as? HTTPURLResponse)?.statusCode == 200 {
        DispatchQueue.main.async { NSApp.terminate(nil) }
      }
    }.resume()
    return false
  }
  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    let target = navigationAction.request.url
    decisionHandler(target?.host == url.host && target?.port == url.port ? .allow : .cancel)
  }
}

guard (2...3).contains(CommandLine.arguments.count), let url = URL(string: CommandLine.arguments[1]),
  url.scheme == "http", url.host == "127.0.0.1", url.port != nil else { exit(2) }
let app = NSApplication.shared
let sizePath = CommandLine.arguments.count == 3 ? URL(fileURLWithPath: CommandLine.arguments[2]) : nil
let delegate = UpdateWindow(url: url, sizePath: sizePath)
app.delegate = delegate
app.run()
