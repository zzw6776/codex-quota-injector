function createModelViews(dependencies) {
  const { CUSTOM_REASONING_EFFORTS, state } = dependencies;
  const renderPanelControls = (...args) => dependencies.renderPanelControls(...args);
  const extraPlatformDisplayModels = (...args) => dependencies.extraPlatformDisplayModels(...args);
  const modelDetectionOperation = (...args) => dependencies.modelDetectionOperation(...args);
  const renderPlatformDetectionProgress = (...args) => dependencies.renderPlatformDetectionProgress(...args);
  const renderExtraPlatformForm = (...args) => dependencies.renderExtraPlatformForm(...args);
  const formatUpdatedAt = (...args) => dependencies.formatUpdatedAt(...args);
  const escapeHtml = (...args) => dependencies.escapeHtml(...args);

function renderManagedDeepSeekBalance(data, platform) {
    const view = data?.deepSeekBalance ?? {};
    const configured = Boolean(platform?.apiKey);
    const items = Array.isArray(view.balance?.items) ? view.balance.items : [];
    const cards = items.length
      ? items.map((item) => `<div class="balance-card"><div class="balance-currency">${escapeHtml(item.currency)}</div><div class="balance-total">${escapeHtml(item.totalBalance)}</div><div class="balance-detail">赠送余额 ${escapeHtml(item.grantedBalance)} · 充值余额 ${escapeHtml(item.toppedUpBalance)}</div></div>`).join("")
      : `<div class="context-empty">${configured ? "暂无可用余额数据" : "保存 API Key 后可查询余额"}</div>`;
    const error = view.error
      ? `<div class="quota-error">${escapeHtml(view.error)}（保留上次成功余额）</div>`
      : "";
    const status = view.balance
      ? ` · ${view.balance.available ? "账户可用" : "账户不可用"}`
      : "";
    return `<section class="balance-section managed-deepseek-balance" data-platform-id="${escapeHtml(platform?.id ?? "")}"><div class="balance-head"><span>账户余额${status} · ${escapeHtml(formatUpdatedAt(view.updatedAt))}</span><button class="btn extra-deepseek-refresh-balance" type="button" ${!configured || view.refreshing ? "disabled" : ""}>${view.refreshing ? "查询中" : "查询余额"}</button></div><div class="balance-grid">${cards}</div>${error}</section>`;
  }

function renderExtraModelsPage() {
    const data = state.data.extraModels ?? {};
    const platforms = Array.isArray(data.platforms) ? data.platforms : [];
    const supported = data.supported !== false;
    const pendingRestart = Boolean(data.pendingRestart);
    const modelOperation = data.operation ?? state.extraModelOperationDraft;
    const operationBusy = modelOperation?.state === "loading";
    const catalogConflicts = Array.isArray(data.catalogConflicts) ? data.catalogConflicts : [];
    const statusMessage = renderExtraModelFeedback(data, modelOperation);
    const catalogConflictMessage = catalogConflicts.length
      ? `<div class="quota-error">以下自定义模型 ID 已被新官方目录占用，本次注入优先使用官方模型，其他自定义模型不受影响：${catalogConflicts.map((item) => escapeHtml(item.modelId)).join("、")}</div>`
      : "";
    const content = state.extraPlatformDraft
      ? renderExtraPlatformForm(state.extraPlatformDraft, supported && !operationBusy)
      : `<div class="extra-platform-toolbar"><span>DeepSeek 已内置；其他兼容平台仍可手动添加</span><button class="btn primary extra-platform-add" type="button" ${supported && !operationBusy ? "" : "disabled"}>添加平台</button></div>
        <div class="extra-platform-list">${platforms.length
          ? platforms.map((platform) => `<article class="extra-platform-card" data-platform-id="${escapeHtml(platform.id)}">
              <div class="extra-platform-head"><div class="extra-platform-name">${escapeHtml(platform.name)}</div><div class="badges">${platform.preset === "deepseek" ? '<span class="badge">官方预设</span>' : ""}<span class="badge ${platform.enabled ? "current" : ""}">${platform.enabled ? "已启用" : "未启用"}</span><button class="btn extra-platform-edit" type="button" data-platform-id="${escapeHtml(platform.id)}" ${supported ? "" : "disabled"}>${platform.preset === "deepseek" ? "设置" : "编辑"}</button></div></div>
              <div class="extra-platform-url">${escapeHtml(platform.baseUrl)}</div>
              <div class="extra-platform-meta">${platform.models.filter((model) => model.selected !== false).length} / ${platform.models.length} 个模型已选 · 可逐个检测或手动配置</div>
              <div class="extra-platform-progress">${renderPlatformDetectionProgress(platform, modelOperation)}</div>
              <div class="extra-platform-model-status">${extraPlatformDisplayModels(platform).map((model, index) => renderExtraModelCardStatus(model, index, modelDetectionOperation(model, platform.id))).join("")}</div>
              ${platform.preset === "deepseek" ? renderManagedDeepSeekBalance(data, platform) : ""}
            </article>`).join("")
          : '<div class="context-empty">尚未添加额外模型平台</div>'}</div>`;
    return `
      <header class="panel-head"><div class="panel-title-wrap"><button class="icon-btn extra-models-back" type="button" aria-label="${state.extraPlatformDraft ? "返回模型管理" : "返回账号额度"}">←</button><div><div class="panel-title">模型管理</div><div class="panel-subtitle">平台、模型与兼容能力</div></div></div>${renderPanelControls()}</header>
      <section class="provider-summary"><div class="provider-status"><span class="${platforms.some((platform) => platform.enabled) ? "enabled" : "disabled"}">${platforms.some((platform) => platform.enabled) ? "已配置启用平台" : "暂无启用平台"}</span><span class="badge">${platforms.length} 个平台</span>${pendingRestart ? '<span class="badge pending-restart">等待重启生效</span>' : ""}</div><div class="provider-note">保存不检测、不消耗模型 Token。可在每个模型下单独检测并填入参数，也可手动配置。只有点击检测才发送真实模型请求。</div></section>
      ${content}
      ${catalogConflictMessage}
      ${supported ? "" : '<div class="quota-error">额外模型共存当前仅支持 macOS 和 Windows。</div>'}
      <div class="extra-model-feedback" aria-live="polite">${statusMessage}</div>`;
  }

function renderExtraModelFeedback(data, operation = data?.operation) {
    if (operation?.state === "loading") {
      return operation.phase === "detecting" ? "" : renderExtraModelProgress(operation);
    }
    return data?.message
      ? `<div class="operation ${data.messageState === "error" ? "error" : "success"}">${escapeHtml(data.message)}</div>`
      : "";
  }

function renderExtraModelProgress(operation) {
    if (operation?.state !== "loading") return "";
    const current = Math.max(1, Math.floor(Number(operation.current) || 1));
    const total = Math.max(current, Math.floor(Number(operation.total) || current));
    const step = Math.max(0, Math.floor(Number(operation.step) || 0));
    const steps = Math.max(step, Math.floor(Number(operation.steps) || 0));
    if (operation.phase !== "detecting" || steps === 0) {
      return `<div class="operation extra-model-progress" role="status">${escapeHtml(operation.message || "正在处理模型配置")}</div>`;
    }
    const modelProgress = Math.min(1, step / steps);
    const percent = Math.max(1, Math.min(100, Math.round(
      ((current - 1 + modelProgress) / total) * 100,
    )));
    const detail = `${step}/${steps} · ${operation.detail || "正在检测模型能力"}${operation.retry ? " · 重试中" : ""}`;
    return `<div class="operation extra-model-progress" role="status" aria-live="polite">
      <div class="extra-model-progress-body">
        <div class="extra-model-progress-head"><span class="extra-model-progress-title">${escapeHtml(operation.message || "正在检测模型")}</span><span class="extra-model-progress-percent">${percent}%</span></div>
        <span class="extra-model-progress-track" aria-hidden="true"><i style="width:${percent}%"></i></span>
        <div class="extra-model-progress-detail">${escapeHtml(detail)}</div>
      </div>
    </div>`;
  }

function extraModelStatus(model, operation) {
    const c = model?.compatibility ?? {};
    if (operation?.state === "loading" && operation.modelId === model.id) return "检测中…";
    if (model.lastDetection?.status === "failed") return "检测失败";
    if (c.status === "manual") return "手动配置";
    if (c.status === "pending" && Number(c.probeVersion) > 0) return "检测规则已更新";
    if (c.status !== "verified") return "未检测";
    const caps = c.capabilities ?? {};
    const warnings = model.lastDetection?.warnings ?? c.warnings ?? [];
    return warnings.length || c.imageStatus === "inconclusive" ||
      [caps.reasoning, caps.reasoningToolChoice].includes("inconclusive")
      ? "部分可用" : "检测通过";
  }

function renderExtraModelCardStatus(model, index, operation) {
    const status = extraModelStatus(model, operation);
    return `<div data-model-index="${index}"><div class="extra-model-capabilities"><span class="model-label">${escapeHtml(model.displayName || model.id)}</span>${renderExtraModelStatusBadge(status)}${model.configurationUnsaved ? '<span class="extra-model-unsaved">未保存</span>' : ""}</div>${renderExtraModelConfiguration(model)}</div>`;
  }

function renderExtraModelStatusBadge(status) {
    const tone = status === "检测通过" ? " current" : status === "检测失败" ? " detection-failed" : "";
    return `<span class="badge extra-model-main-status${tone}">${status}</span>`;
  }

function renderExtraModelCompatibility(model) {
    const status = extraModelStatus(model, modelDetectionOperation(model));
    const report = model?.lastDetection;
    const c = model?.compatibility ?? {};
    const warnings = report?.warnings ?? c.warnings ?? [];
    const failure = report?.status === "failed"
      ? `<div class="extra-model-detection-error">${escapeHtml(report.message)}<br>本次检测未更新参数，原配置保留。</div>` : "";
    const partial = status === "部分可用"
      ? `<div class="extra-model-detection-detail">对话和工具可用，部分附加能力未完成检测。${warnings.length ? `<br>${warnings.map(escapeHtml).join("<br>")}` : ""}</div>` : "";
    const success = status === "检测通过" ? '<div class="extra-model-detection-detail">参数由检测自动填写。</div>' : "";
    const manual = status === "手动配置" ? '<div class="extra-model-detection-detail">使用你填写的参数，未验证实际效果。</div>' : "";
    const updated = c.status === "pending" && Number(c.probeVersion) > 0
      ? '<div class="extra-model-detection-detail">检测规则已更新，可重新检测或手动配置。</div>' : "";
    return `<div class="extra-model-status" role="status"><div class="extra-model-capabilities">${renderExtraModelStatusBadge(status)}${model.configurationUnsaved ? '<span class="extra-model-unsaved">未保存</span>' : ""}</div>${failure}${partial}${success}${manual}${updated}${renderExtraModelConfiguration(model)}</div>`;
  }

function renderExtraModelConfiguration(model) {
    const compatibility = model?.compatibility ?? {};
    const modelLabel = '<span class="model-label">当前参数</span>';
    if (compatibility.status === "verified") {
      const capabilities = compatibility.capabilities ?? {};
      const bridgedTools = capabilities.customTools === "bridged" ||
        capabilities.namespaceTools === "bridged";
      const protocolId = compatibility.protocol === "chat" ? "chat" : "responses";
      const protocol = protocolId === "chat" ? "Chat 转换" : "Responses";
      const tools = bridgedTools ? "工具已自动适配" : "工具可用";
      const hostedSearch = capabilities.hostedTools?.web_search === "native";
      const search = hostedSearch ? "内置联网可用" : "内置联网不可用";
      const imageSupported = compatibility.imageStatus === "supported";
      const imageProtocol = compatibility.routes?.imageInput === "chat" ? "chat" : protocolId;
      const image = imageSupported
        ? imageProtocol === protocolId ? "支持图片" : "支持图片 · Chat"
        : compatibility.imageStatus === "inconclusive" ? "图片暂不可用（检测未完成）" : "不支持图片";
      const reasoningSupported = capabilities.reasoning === "native";
      const reasoning = reasoningSupported ? "推理：支持" : capabilities.reasoning === "inconclusive" ? "推理暂不可用" : "推理：不支持";
      const reasoningEfforts = Array.isArray(model.reasoningEfforts)
        ? model.reasoningEfforts.filter((effort) => CUSTOM_REASONING_EFFORTS.includes(effort))
        : [];
      const effortBadge = reasoningEfforts.length
        ? `<span class="badge current">推理强度：${escapeHtml(reasoningEfforts.join(" / "))}（实测接受）</span>`
        : "";
      const checkedAt = compatibility.checkedAt
        ? ` title="检测于 ${escapeHtml(formatUpdatedAt(compatibility.checkedAt))}"`
        : "";
      return `<div class="extra-model-capabilities"${checkedAt}>${modelLabel}<span class="badge current">${protocol}</span><span class="badge current">${tools}</span><span class="badge${reasoningSupported ? " current" : ""}">${reasoning}</span>${effortBadge}<span class="badge${hostedSearch ? " current" : ""}" title="由模型供应商在请求内执行的联网搜索；Codex 独立 web.run 属于另一项能力">${search}</span><span class="badge${imageSupported ? " current" : ""}">${image}</span></div>`;
    }
    return "";
  }

  return { renderManagedDeepSeekBalance, renderExtraModelsPage, renderExtraModelFeedback, renderExtraModelProgress, extraModelStatus, renderExtraModelCardStatus, renderExtraModelStatusBadge, renderExtraModelCompatibility, renderExtraModelConfiguration };
}

export { createModelViews };
