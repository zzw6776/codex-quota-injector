import AppKit
import Darwin
import Foundation

private let officialBundleIdentifier = "com.openai.codex"
private let standardOfficialExecutables = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
  FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Applications/ChatGPT.app/Contents/Resources/codex").path,
  FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Applications/Codex.app/Contents/Resources/codex").path,
]

private struct LaunchConfiguration: Decodable {
  let upstreamExecutable: String
  let relayExecutable: String?
  let relayArguments: [String]?
  let modelCatalogPath: String?
  let relayStatePath: String?
  let generation: String?
  let router: RouterConfiguration?
}

private struct RouterConfiguration: Decodable {
  let providerId: String
  let baseUrl: String
  let tokenEnv: String
  let tokenHeader: String
  let legacyProviderIds: [String]
}

private func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("Codex Quota Injector Shim: \(message)\n".utf8))
  exit(1)
}

private func canonicalPath(_ path: String) -> String {
  let base = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
  return URL(fileURLWithPath: path, relativeTo: base)
    .standardizedFileURL
    .resolvingSymlinksInPath()
    .path
}

private func isUsableOfficialExecutable(_ path: String) -> Bool {
  FileManager.default.isExecutableFile(atPath: path) &&
    canonicalPath(path) != canonicalPath(CommandLine.arguments[0])
}

private func resolveOfficialExecutable(fallback: String?) -> String? {
  var candidates: [String] = []
  if let fallback, !fallback.isEmpty {
    candidates.append(fallback)
  }
  candidates.append(contentsOf: NSRunningApplication
    .runningApplications(withBundleIdentifier: officialBundleIdentifier)
    .compactMap { application in
      application.bundleURL?
        .appendingPathComponent("Contents/Resources/codex")
        .path
    })
  candidates.append(contentsOf: standardOfficialExecutables)

  var visited = Set<String>()
  for candidate in candidates {
    let canonical = canonicalPath(candidate)
    if visited.insert(canonical).inserted && isUsableOfficialExecutable(candidate) {
      return candidate
    }
  }
  return nil
}

private func clearBootstrapEnvironment() {
  for key in [
    "CODEX_QUOTA_RELAY_CONFIG",
    "CODEX_QUOTA_UPSTREAM_CODEX_CLI",
    "CODEX_QUOTA_ROLE",
    "CODEX_APP_SERVER_FORCE_CLI",
    "CODEX_APP_SERVER_WS_URL",
  ] {
    unsetenv(key)
  }
}

private func clearInjectorEnvironment() {
  for key in ProcessInfo.processInfo.environment.keys where key.hasPrefix("CODEX_QUOTA_") {
    unsetenv(key)
  }
  clearBootstrapEnvironment()
}

private func jsonQuote(_ value: String) -> String {
  let encoder = JSONEncoder()
  // JSON allows escaping every slash as `\/`, while TOML basic strings do not.
  // Keep the remaining JSON string escaping, which is compatible with TOML.
  encoder.outputFormatting = [.withoutEscapingSlashes]
  guard
    let data = try? encoder.encode(value),
    let encoded = String(data: data, encoding: .utf8)
  else {
    fail("无法编码 Codex 启动参数")
  }
  return encoded
}

private func providerOverride(_ providerId: String, router: RouterConfiguration) -> String {
  let safeProviderId = providerId.unicodeScalars.allSatisfy {
    CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_-")).contains($0)
  }
  guard safeProviderId else { fail("模型供应商 ID 不安全") }
  return "model_providers.\(providerId)={" +
    "name=\(jsonQuote("Codex Quota Router"))," +
    "base_url=\(jsonQuote(router.baseUrl))," +
    "requires_openai_auth=true," +
    "wire_api=\"responses\"," +
    "supports_websockets=false," +
    "env_http_headers={\(jsonQuote(router.tokenHeader))=\(jsonQuote(router.tokenEnv))}}"
}

private func writeRelayState(_ configuration: LaunchConfiguration) {
  guard let path = configuration.relayStatePath, !path.isEmpty else { return }
  let state: [String: Any] = [
    "version": 2,
    "pid": Int(getpid()),
    "processStartedAt": Date().timeIntervalSince1970 * 1000,
    "generation": configuration.generation as Any? ?? NSNull(),
  ]
  do {
    let data = try JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted, .sortedKeys])
    let url = URL(fileURLWithPath: path)
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    try data.write(to: url, options: .atomic)
    chmod(path, 0o600)
  } catch {
    fail("无法写入桥接状态：\(error.localizedDescription)")
  }
}

private func execProcess(
  _ executable: String,
  arguments: [String],
  failureDescription: String
) -> Never {
  let values = [executable] + arguments
  var pointers: [UnsafeMutablePointer<CChar>?] = values.map { strdup($0) }
  pointers.append(nil)
  _ = pointers.withUnsafeMutableBufferPointer { buffer in
    execv(executable, buffer.baseAddress)
  }
  let message = String(cString: strerror(errno))
  for case let pointer? in pointers { free(pointer) }
  fail("无法执行\(failureDescription)：\(message)")
}

private func execOfficial(_ executable: String, arguments: [String]) -> Never {
  setenv("CODEX_CLI_PATH", executable, 1)
  execProcess(executable, arguments: arguments, failureDescription: "官方 Codex")
}

let environment = ProcessInfo.processInfo.environment
let configPath = environment["CODEX_QUOTA_RELAY_CONFIG"]?.trimmingCharacters(in: .whitespacesAndNewlines)
let fallbackExecutable = environment["CODEX_QUOTA_UPSTREAM_CODEX_CLI"]?.trimmingCharacters(in: .whitespacesAndNewlines)
var arguments = Array(CommandLine.arguments.dropFirst())

guard let configPath, !configPath.isEmpty else {
  guard let officialExecutable = resolveOfficialExecutable(fallback: fallbackExecutable) else {
    fail("无法定位官方 Codex CLI")
  }
  clearInjectorEnvironment()
  execOfficial(officialExecutable, arguments: arguments)
}

private let configuration: LaunchConfiguration
do {
  let data = try Data(contentsOf: URL(fileURLWithPath: configPath))
  configuration = try JSONDecoder().decode(LaunchConfiguration.self, from: data)
} catch {
  guard let officialExecutable = resolveOfficialExecutable(fallback: fallbackExecutable) else {
    fail("启动配置不可读：\(error.localizedDescription)")
  }
  clearInjectorEnvironment()
  execOfficial(officialExecutable, arguments: arguments)
}

guard isUsableOfficialExecutable(configuration.upstreamExecutable) else {
  fail("官方 Codex 不存在或不可执行")
}

if let appServerIndex = arguments.firstIndex(of: "app-server") {
  if configuration.router != nil,
     let relayExecutable = configuration.relayExecutable,
     !relayExecutable.isEmpty {
    guard isUsableOfficialExecutable(relayExecutable) else {
      fail("模型 Router 已配置，但 app-server 中继不存在或不可执行")
    }
    setenv("CODEX_QUOTA_ROLE", "app-server-relay", 1)
    setenv("CODEX_QUOTA_RELAY_CONFIG", configPath, 1)
    setenv("CODEX_QUOTA_UPSTREAM_CODEX_CLI", configuration.upstreamExecutable, 1)
    setenv("CODEX_CLI_PATH", configuration.upstreamExecutable, 1)
    execProcess(
      relayExecutable,
      arguments: (configuration.relayArguments ?? []) + arguments,
      failureDescription: "app-server 中继"
    )
  }
  var overrides: [String] = []
  if let catalogPath = configuration.modelCatalogPath, !catalogPath.isEmpty {
    overrides += ["-c", "model_catalog_json=\(jsonQuote(catalogPath))"]
  }
  if let router = configuration.router {
    let providerIds = [router.providerId] + router.legacyProviderIds.filter {
      $0 != router.providerId
    }
    // Keep the built-in `openai` provider canonical so official tasks do not
    // persist an injector-only provider ID. The built-in provider sends both
    // HTTP and WebSocket Responses traffic through this base URL.
    overrides += [
      "-c", "model_provider=\(jsonQuote("openai"))",
      "-c", "openai_base_url=\(jsonQuote(router.baseUrl))",
    ]
    for providerId in providerIds {
      overrides += ["-c", providerOverride(providerId, router: router)]
    }
  }
  arguments.insert(contentsOf: overrides, at: appServerIndex + 1)
  writeRelayState(configuration)
}

clearBootstrapEnvironment()
execOfficial(configuration.upstreamExecutable, arguments: arguments)
