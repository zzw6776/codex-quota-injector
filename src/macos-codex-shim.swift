import AppKit
import Darwin
import Foundation

private let officialBundleIdentifier = "com.openai.codex"
private let sidecarModeEnvironmentKey = "CODEX_QUOTA_APP_SERVER_SIDECAR"
private let sidecarUpstreamStdinEnvironmentKey = "CODEX_QUOTA_UPSTREAM_STDIN_FD"
private let sidecarUpstreamStdoutEnvironmentKey = "CODEX_QUOTA_UPSTREAM_STDOUT_FD"
private let primaryAppServerEnvironmentKey = "CODEX_QUOTA_PRIMARY_APP_SERVER"
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
  let hostToolsRequired: Bool?
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
    primaryAppServerEnvironmentKey,
    "CODEX_APP_SERVER_FORCE_CLI",
    "CODEX_APP_SERVER_WS_URL",
    sidecarModeEnvironmentKey,
    sidecarUpstreamStdinEnvironmentKey,
    sidecarUpstreamStdoutEnvironmentKey,
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

private func writeRelayState(
  _ configuration: LaunchConfiguration,
  processId: pid_t = getpid(),
  terminateOnFailure processToTerminate: pid_t? = nil
) {
  guard let path = configuration.relayStatePath, !path.isEmpty else { return }
  let state: [String: Any] = [
    "version": 2,
    "pid": Int(processId),
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
    if let processToTerminate {
      _ = kill(processToTerminate, SIGTERM)
    }
    fail("无法写入桥接状态：\(error.localizedDescription)")
  }
}

private func closeDescriptor(_ descriptor: Int32) {
  if descriptor >= 0 {
    _ = Darwin.close(descriptor)
  }
}

private func startAppServerRelaySidecar(
  executable: String,
  arguments: [String],
  configPath: String,
  upstreamExecutable: String
) -> pid_t {
  var requestsToUpstream: [Int32] = [-1, -1]
  var responsesFromUpstream: [Int32] = [-1, -1]
  guard Darwin.pipe(&requestsToUpstream) == 0 else {
    fail("无法创建 app-server 请求管道：\(String(cString: strerror(errno)))")
  }
  guard Darwin.pipe(&responsesFromUpstream) == 0 else {
    closeDescriptor(requestsToUpstream[0])
    closeDescriptor(requestsToUpstream[1])
    fail("无法创建 app-server 响应管道：\(String(cString: strerror(errno)))")
  }

  var fileActions: posix_spawn_file_actions_t? = nil
  let actionsStatus = posix_spawn_file_actions_init(&fileActions)
  guard actionsStatus == 0 else {
    for descriptor in requestsToUpstream + responsesFromUpstream {
      closeDescriptor(descriptor)
    }
    fail("无法初始化 app-server 中继 sidecar：\(String(cString: strerror(actionsStatus)))")
  }
  defer { posix_spawn_file_actions_destroy(&fileActions) }
  posix_spawn_file_actions_addclose(&fileActions, requestsToUpstream[0])
  posix_spawn_file_actions_addclose(&fileActions, responsesFromUpstream[1])

  setenv("CODEX_QUOTA_ROLE", "app-server-relay", 1)
  setenv("CODEX_QUOTA_RELAY_CONFIG", configPath, 1)
  setenv("CODEX_QUOTA_UPSTREAM_CODEX_CLI", upstreamExecutable, 1)
  setenv("CODEX_CLI_PATH", upstreamExecutable, 1)
  setenv(sidecarModeEnvironmentKey, "1", 1)
  setenv(sidecarUpstreamStdinEnvironmentKey, String(requestsToUpstream[1]), 1)
  setenv(sidecarUpstreamStdoutEnvironmentKey, String(responsesFromUpstream[0]), 1)

  let values = [executable] + arguments
  var pointers: [UnsafeMutablePointer<CChar>?] = values.map { strdup($0) }
  pointers.append(nil)
  var child: pid_t = 0
  let spawnStatus = executable.withCString { executablePointer in
    pointers.withUnsafeMutableBufferPointer { buffer in
      posix_spawn(
        &child,
        executablePointer,
        &fileActions,
        nil,
        buffer.baseAddress,
        environ
      )
    }
  }
  for case let pointer? in pointers { free(pointer) }
  guard spawnStatus == 0 else {
    for descriptor in requestsToUpstream + responsesFromUpstream {
      closeDescriptor(descriptor)
    }
    fail("无法创建 app-server 中继 sidecar：\(String(cString: strerror(spawnStatus)))")
  }

  closeDescriptor(requestsToUpstream[1])
  closeDescriptor(responsesFromUpstream[0])
  guard dup2(requestsToUpstream[0], STDIN_FILENO) >= 0 else {
    closeDescriptor(requestsToUpstream[0])
    closeDescriptor(responsesFromUpstream[1])
    _ = kill(child, SIGTERM)
    fail("无法连接官方 app-server 标准输入：\(String(cString: strerror(errno)))")
  }
  guard dup2(responsesFromUpstream[1], STDOUT_FILENO) >= 0 else {
    closeDescriptor(requestsToUpstream[0])
    closeDescriptor(responsesFromUpstream[1])
    _ = kill(child, SIGTERM)
    fail("无法连接官方 app-server 标准输出：\(String(cString: strerror(errno)))")
  }
  closeDescriptor(requestsToUpstream[0])
  closeDescriptor(responsesFromUpstream[1])
  return child
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

private let publishesHostState: Bool = {
  // The managed desktop launch always marks its primary app-server explicitly.
  // Nested task app-servers can lose their parent's --listen argument, so argv
  // is not a safe ownership signal for the process-global Relay state.
  environment[primaryAppServerEnvironmentKey] == "1"
}()

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
  var relayProcessId: pid_t? = nil
  let relayRequired = configuration.hostToolsRequired == true || configuration.router != nil
  if relayRequired {
    guard let relayExecutable = configuration.relayExecutable,
          !relayExecutable.isEmpty else {
      fail("app-server 观察中继已启用，但中继路径为空")
    }
    guard isUsableOfficialExecutable(relayExecutable) else {
      fail("app-server 观察中继不存在或不可执行")
    }
    relayProcessId = startAppServerRelaySidecar(
      executable: relayExecutable,
      arguments: (configuration.relayArguments ?? []) + arguments,
      configPath: configPath,
      upstreamExecutable: configuration.upstreamExecutable
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
  if publishesHostState {
    writeRelayState(
      configuration,
      processId: relayProcessId ?? getpid(),
      terminateOnFailure: relayProcessId
    )
  }
}

clearBootstrapEnvironment()
execOfficial(configuration.upstreamExecutable, arguments: arguments)
