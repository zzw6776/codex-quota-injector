import AppKit
import WebKit
import Foundation

final class UpdateWindow: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate {
  private var window: NSWindow!
  private var webView: WKWebView!
  private var focusSignal: DispatchSourceSignal?
  private let url: URL
  init(url: URL) { self.url = url; super.init() }
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 510),
      styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
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
  func windowShouldClose(_ sender: NSWindow) -> Bool {
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

guard CommandLine.arguments.count == 2, let url = URL(string: CommandLine.arguments[1]),
  url.scheme == "http", url.host == "127.0.0.1", url.port != nil else { exit(2) }
let app = NSApplication.shared
let delegate = UpdateWindow(url: url)
app.delegate = delegate
app.run()
