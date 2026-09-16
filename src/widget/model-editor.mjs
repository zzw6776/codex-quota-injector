// Browser-serializable factory: all external values arrive through this explicit boundary.
function createModelEditor({ state, renderModelDetectionProgress, renderExtraModelCompatibility, formatUpdatedAt, contextTokensToK, contextKToTokens, escapeHtml, render, setExtraPlatformDraft, forgetModelDetection, bindExtraModelDetectButtons, showExtraModelOperation, bindManagedDeepSeekBalanceButtons, enqueue }) {
  function renderExtraPlatformForm(platform, editable) {
    if (platform.preset === "deepseek") return renderDeepSeekPresetForm(platform, editable);
    const models = Array.isArray(platform.models) && platform.models.length
      ? platform.models
      : [blankExtraModel()];
    return `<form class="extra-platform-form" data-platform-id="${escapeHtml(platform.id ?? "")}">
      <label class="provider-toggle"><input name="enabled" type="checkbox" ${platform.enabled ? "checked" : ""} ${editable ? "" : "disabled"}>在模型列表中启用该平台</label>
      <div class="provider-field"><label>平台名称</label><input name="name" value="${escapeHtml(platform.name ?? "")}" placeholder="例如 TokenHub" required ${editable ? "" : "disabled"}></div>
      <div class="provider-field"><label>API Base URL</label><input name="baseUrl" value="${escapeHtml(platform.baseUrl ?? "")}" placeholder="https://example.com/v1" spellcheck="false" required ${editable ? "" : "disabled"}></div>
      <div class="provider-field"><label>API Key（本地明文保存并完整回显）</label><input class="provider-key" name="apiKey" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(platform.apiKey ?? "")}" placeholder="th-..." ${editable ? "" : "disabled"}></div>
      <div class="extra-models-head"><span>平台模型</span><button class="btn extra-model-add" type="button" ${editable ? "" : "disabled"}>添加模型</button></div>
      <div class="extra-model-list">${models.map((model, index) => `<div class="extra-model-row" data-model-index="${index}">
        <div class="provider-field"><label>模型 ID</label><input name="modelId" value="${escapeHtml(model.id ?? "")}" placeholder="model-id" required ${editable ? "" : "disabled"}></div>
        <div class="provider-field"><label>显示名称</label><input name="displayName" value="${escapeHtml(model.displayName ?? "")}" placeholder="模型显示名称" ${editable ? "" : "disabled"}></div>
        <div class="provider-field"><label>上下文（K）</label><input name="contextWindow" type="number" min="1" step="0.001" value="${escapeHtml(contextTokensToK(model.contextWindow ?? 128000))}" required ${editable ? "" : "disabled"}></div>
        <button class="btn extra-model-remove" type="button" ${editable && models.length > 1 ? "" : "disabled"}>移除</button>
        ${renderExtraModelCompatibility(model)}
        <button class="btn extra-model-detect" type="button" ${editable ? "" : "disabled"}>检测此模型（消耗 Token）</button>${renderModelDetectionProgress(model)}
        ${renderExtraModelReasoning(model, editable)}
      </div>`).join("")}</div>
      <div class="provider-warning">Key 保存在 ${escapeHtml(state.data.extraModels?.settingsPath ?? "本地 extra-model-settings.json")}；不写入系统安全存储。保存不会执行检测；可以手动填写参数，重启 Codex 后生效。</div>
      <div class="provider-actions">${platform.id ? '<button class="btn extra-platform-remove" type="button">删除平台</button>' : ""}<button class="btn extra-platform-cancel" type="button">取消</button><button class="btn primary" type="submit" ${editable ? "" : "disabled"}>保存配置</button></div>
    </form>`;
  }

  function renderDeepSeekPresetForm(platform, editable) {
    const models = Array.isArray(platform.models) ? platform.models : [];
    const refreshed = platform.modelsUpdatedAt
      ? `最近读取：${escapeHtml(formatUpdatedAt(platform.modelsUpdatedAt))}`
      : "可点击“读取最新模型”更新列表";
    return `<form class="extra-platform-form preset-platform-form" data-platform-id="${escapeHtml(platform.id ?? "")}" data-platform-preset="deepseek">
      <label class="provider-toggle"><input name="enabled" type="checkbox" ${platform.enabled ? "checked" : ""} ${editable ? "" : "disabled"}>在模型列表中启用 DeepSeek</label>
      <div class="provider-field"><label>DeepSeek API Key（本地明文保存并完整回显）</label><input class="provider-key" name="apiKey" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(platform.apiKey ?? "")}" placeholder="sk-..." ${editable ? "" : "disabled"}></div>
      <div class="preset-platform-note"><span>官方地址：${escapeHtml(platform.baseUrl)}</span><span>模型列表由 DeepSeek 官方 /models 接口读取；各模型可独立检测，也可手动配置；上下文按 K 填写。</span><span>${refreshed}</span></div>
      ${renderDeepSeekModelPicker(models, editable)}
      <div class="provider-warning">保存不读取模型列表，也不执行检测。点击模型下的检测按钮才消耗 Token；检测结果填入后仍需保存。Key 保存在 ${escapeHtml(state.data.extraModels?.settingsPath ?? "本地 extra-model-settings.json")}。保存后等待重启 Codex 生效。</div>
      <div class="provider-actions"><button class="btn preset-model-refresh" type="button" ${editable ? "" : "disabled"}>读取最新模型</button><button class="btn extra-platform-cancel" type="button">取消</button><button class="btn primary" type="submit" ${editable ? "" : "disabled"}>保存配置</button></div>
    </form>`;
  }

  function renderDeepSeekModelPicker(models, editable) {
    const selectedCount = models.filter((model) => model.selected !== false).length;
    return `<details class="preset-model-picker" ${models.length <= 3 ? "open" : ""}><summary><span>可用模型</span><span class="badge current preset-model-count">已选 ${selectedCount} / ${models.length}</span></summary><div class="preset-model-options">${models.map((model, index) => `<div class="preset-model-option" data-model-index="${index}"><label class="preset-model-option-select"><input name="presetModel" type="checkbox" value="${escapeHtml(model.id)}" ${model.selected !== false ? "checked" : ""} ${editable ? "" : "disabled"}><div class="preset-model-option-main"><div class="preset-model-option-name">${escapeHtml(model.displayName || model.id)}</div><div class="preset-model-option-id">${escapeHtml(model.id)}</div>${renderExtraModelCompatibility(model)}</div></label><label class="preset-model-context"><span>上下文</span><input name="presetContextWindow" data-model-id="${escapeHtml(model.id)}" type="number" min="1" step="0.001" value="${escapeHtml(contextTokensToK(model.contextWindow ?? 128000))}" required ${editable ? "" : "disabled"}><span>K</span></label><button class="btn extra-model-detect" type="button" ${editable ? "" : "disabled"}>检测此模型（消耗 Token）</button>${renderModelDetectionProgress(model)}${renderExtraModelReasoning(model, editable)}</div>`).join("")}</div></details>`;
  }

  function renderExtraModelReasoning(model, editable) {
    const c = model.compatibility ?? {};
    const caps = c.capabilities ?? {};
    const select = (name, label, value, options) => `<div class="provider-field"><label>${label}</label><select name="${name}" ${editable ? "" : "disabled"}>${options.map(([id, text]) => `<option value="${id}" ${id === value ? "selected" : ""}>${text}</option>`).join("")}</select></div>`;
    const check = (name, label, enabled) => `<label class="provider-toggle"><input name="${name}" type="checkbox" ${enabled ? "checked" : ""} ${editable ? "" : "disabled"}>${label}</label>`;
    const choiceOptions = [["native", "支持指定工具"], ["auto-only", "仅自动选择"], ["unsupported", "不发送该参数"]];
    return `<details class="extra-model-settings extra-model-reasoning"><summary>手动配置参数（可跳过检测）</summary><div class="extra-model-settings-body">
      ${select("modelProtocol", "接口类型", c.protocol ?? "responses", [["responses", "Responses"], ["chat", "Chat Completions（自动转换）"]])}
      ${select("historyMode", "推理历史", c.historyMode === "reasoning-text-only" ? c.historyMode : "responses-full", [["responses-full", "保留完整历史"], ["reasoning-text-only", "仅保留推理正文"]])}
      ${select("toolFormat", "Codex 工具格式", caps.customTools === "native" && caps.namespaceTools === "native" ? "native" : "bridged", [["bridged", "转换为普通函数工具"], ["native", "平台原生支持 Codex 工具"]])}
      ${check("supportsImage", "支持图片", c.supportsImage === true)}
      ${check("supportsReasoning", "支持推理", caps.reasoning === "native" || model.reasoningEfforts?.length > 0)}
      <div class="provider-field"><label>推理强度（逗号分隔，可留空）</label><input name="reasoningEfforts" value="${escapeHtml((model.reasoningEfforts ?? []).join(", "))}" placeholder="low, medium, high, xhigh, max" ${editable ? "" : "disabled"}></div>
      <div class="provider-field"><label>默认推理强度（可留空）</label><input name="defaultReasoningEffort" value="${escapeHtml(model.defaultReasoningEffort ?? "")}" ${editable ? "" : "disabled"}></div>
      ${check("parallelTools", "支持并行工具", caps.parallelTools === "native")}
      ${check("hostedSearch", "支持平台内置联网", caps.hostedTools?.web_search === "native")}
      ${select("toolChoice", "普通对话选择工具", caps.toolChoice ?? "unsupported", choiceOptions.filter(([id]) => id !== "auto-only"))}
      ${select("reasoningToolChoice", "推理时选择工具", caps.reasoningToolChoice ?? "unsupported", choiceOptions)}
    </div></details>`;
  }

  function readExtraModelSettings(row, model, forSave = false) {
    const settings = row?.querySelector(".extra-model-settings");
    if (!settings || !settings.dataset.changed &&
      (!forSave || ["verified", "manual", "legacy"].includes(model?.compatibility?.status))) return model;
    const value = name => settings.querySelector(`[name="${name}"]`)?.value;
    const checked = name => Boolean(settings.querySelector(`[name="${name}"]`)?.checked);
    const protocol = value("modelProtocol");
    const image = checked("supportsImage");
    const reasoning = checked("supportsReasoning");
    const efforts = reasoning ? (value("reasoningEfforts") ?? "").split(/[,，\s/]+/).filter(Boolean) : [];
    const toolFormat = protocol === "chat" ? "bridged" : value("toolFormat");
    return { ...model, configurationUnsaved: true, lastDetection: null, reasoningEfforts: efforts,
      defaultReasoningEffort: reasoning ? value("defaultReasoningEffort") : "",
      compatibility: { status: "manual", protocol, routes: { default: protocol, imageInput: protocol },
        historyMode: protocol === "chat" ? "chat" : value("historyMode"),
        supportsImage: image, imageStatus: image ? "supported" : "unsupported",
        checkedAt: null, probeVersion: 0, targetFingerprint: null, codexConformance: "inconclusive",
        capabilities: { transport: { [protocol]: "native" }, streaming: "native", functionTools: "native",
          customTools: toolFormat, namespaceTools: toolFormat, nativeCustomTools: toolFormat === "native" ? ["*"] : [],
          reasoning: reasoning ? "native" : "unsupported", imageInput: image ? "native" : "unsupported",
          parallelTools: checked("parallelTools") ? "native" : "unsupported",
          hostedTools: { web_search: checked("hostedSearch") ? "native" : "unsupported" },
          toolChoice: value("toolChoice"), reasoningToolChoice: value("reasoningToolChoice") } } };
  }

  function blankExtraModel() {
    return {
      id: "",
      displayName: "",
      contextWindow: 128000,
      compatibility: { status: "pending" },
      reasoningEfforts: [],
      defaultReasoningEffort: "",
    };
  }

  function readExtraPlatformForm(form, forSave = false) {
    if (!form) return state.extraPlatformDraft;
    if (form.dataset.platformPreset === "deepseek") {
      const selected = new Set([...form.querySelectorAll('[name="presetModel"]:checked')]
        .map((input) => input.value));
      const contexts = new Map([...form.querySelectorAll('[name="presetContextWindow"]')]
        .map((input) => [input.dataset.modelId, contextKToTokens(input.value)]));
      return {
        ...state.extraPlatformDraft,
        id: form.dataset.platformId ?? "",
        preset: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/",
        apiKey: form.querySelector('[name="apiKey"]')?.value ?? "",
        enabled: Boolean(form.querySelector('[name="enabled"]')?.checked),
        models: (state.extraPlatformDraft?.models ?? []).map((model, index) => ({
          ...readExtraModelSettings(form.querySelector(`[data-model-index="${index}"]`), model, forSave),
          selected: selected.has(model.id),
          contextWindow: contexts.get(model.id) ?? model.contextWindow,
        })),
      };
    }
    return {
      id: form.dataset.platformId ?? "",
      name: form.querySelector('[name="name"]')?.value ?? "",
      baseUrl: form.querySelector('[name="baseUrl"]')?.value ?? "",
      apiKey: form.querySelector('[name="apiKey"]')?.value ?? "",
      enabled: Boolean(form.querySelector('[name="enabled"]')?.checked),
      models: [...form.querySelectorAll(".extra-model-row")].map((row, index) => ({
        ...readExtraModelSettings(row, state.extraPlatformDraft?.models?.[index] ?? blankExtraModel(), forSave),
        id: row.querySelector('[name="modelId"]')?.value ?? "",
        displayName: row.querySelector('[name="displayName"]')?.value ?? "",
        contextWindow: contextKToTokens(row.querySelector('[name="contextWindow"]')?.value),
        selected: true,
      })),
    };
  }

  function bindModelFormEvents(wrap) {
bindManagedDeepSeekBalanceButtons(wrap);
wrap.querySelector(".extra-platform-add")?.addEventListener("click", () => {
      setExtraPlatformDraft(state.extraPlatformDrafts.get("") ?? {
        id: "",
        name: "",
        baseUrl: "",
        apiKey: "",
        enabled: true,
        models: [blankExtraModel()],
      });
      render();
    });
wrap.querySelectorAll(".extra-platform-edit").forEach((button) => button.addEventListener("click", () => {
      const platform = state.data.extraModels?.platforms?.find((item) => item.id === button.dataset.platformId);
      if (!platform) return;
      setExtraPlatformDraft(state.extraPlatformDrafts.get(platform.id) ?? structuredClone(platform));
      render();
    }));
bindExtraModelDetectButtons(wrap);
const extraPlatformForm = wrap.querySelector(".extra-platform-form");
wrap.querySelector(".preset-model-refresh")?.addEventListener("click", (event) => {
      const platform = readExtraPlatformForm(extraPlatformForm);
      setExtraPlatformDraft(platform);
      event.currentTarget.disabled = true;
      enqueue({ type: "extra-platform-models-refresh", platform });
      showExtraModelOperation({
        message: "正在读取 DeepSeek 可用模型",
        platformId: platform.id,
        phase: "models",
      });
    });
extraPlatformForm?.addEventListener("input", (event) => {
      const settings = event.target.closest(".extra-model-settings");
      if (settings) settings.dataset.changed = "true";
      const draft = readExtraPlatformForm(extraPlatformForm);
      if (settings || event.target.name === "modelId") {
        const index = Number(event.target.closest("[data-model-index]")?.dataset.modelIndex);
        forgetModelDetection(draft.id, state.extraPlatformDraft?.models[index]?.id);
      } else if (["apiKey", "baseUrl"].includes(event.target.name)) {
        forgetModelDetection(draft.id);
      }
      if (settings) delete settings.dataset.changed;
      if (["apiKey", "baseUrl", "modelId"].includes(event.target.name)) {
        const changedIndex = event.target.name === "modelId"
          ? Number(event.target.closest("[data-model-index]")?.dataset.modelIndex) : null;
        draft.models = draft.models.map((model, index) => changedIndex != null && index !== changedIndex ? model : {
          ...model, configurationUnsaved: true, lastDetection: null,
          compatibility: model.compatibility?.status === "verified" ? { ...model.compatibility,
            status: "manual", checkedAt: null, probeVersion: 0, targetFingerprint: null, codexConformance: "inconclusive" }
            : model.compatibility,
        });
      }
      setExtraPlatformDraft(draft);
      for (const row of extraPlatformForm.querySelectorAll("[data-model-index]")) {
        const status = row.querySelector(".extra-model-status");
        if (status) status.outerHTML = renderExtraModelCompatibility(draft.models[Number(row.dataset.modelIndex)]);
      }
    });
extraPlatformForm?.addEventListener("change", (event) => {
      const draft = readExtraPlatformForm(extraPlatformForm);
      if (event.target?.name === "presetModel") {
        setExtraPlatformDraft(draft);
        const selectedCount = draft.models.filter((model) => model.selected !== false).length;
        const count = extraPlatformForm.querySelector(".preset-model-count");
        if (count) count.textContent = `已选 ${selectedCount} / ${draft.models.length}`;
        return;
      }
      setExtraPlatformDraft(draft);
    });
wrap.querySelector(".extra-model-add")?.addEventListener("click", () => {
      const draft = readExtraPlatformForm(extraPlatformForm);
      draft.models.push(blankExtraModel());
      setExtraPlatformDraft(draft);
      render();
    });
wrap.querySelectorAll(".extra-model-remove").forEach((button) => button.addEventListener("click", () => {
      const draft = readExtraPlatformForm(extraPlatformForm);
      const index = Number(button.closest(".extra-model-row")?.dataset.modelIndex);
      if (Number.isInteger(index) && draft.models.length > 1) {
        forgetModelDetection(draft.id, draft.models[index]?.id);
        draft.models.splice(index, 1);
      }
      setExtraPlatformDraft(draft);
      render();
    }));
wrap.querySelector(".extra-platform-cancel")?.addEventListener("click", () => {
      forgetModelDetection(state.extraPlatformDraft?.id);
      state.extraPlatformDrafts.delete(state.extraPlatformDraft?.id);
      state.extraModelOperationDraft = null;
      setExtraPlatformDraft(null);
      render();
    });
extraPlatformForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      const platform = readExtraPlatformForm(event.currentTarget, true);
      setExtraPlatformDraft(platform);
      const requestId = crypto.randomUUID();
      state.extraPlatformSaveRequest = { requestId, draft: platform, snapshot: JSON.stringify(platform.models) };
      enqueue({ type: "extra-platform-save", platform, requestId });
      event.currentTarget.querySelector('button[type="submit"]')?.setAttribute("disabled", "");
      showExtraModelOperation({
        message: "正在保存配置（不执行检测）",
        platformId: platform.id,
        phase: "saving",
      });
    });
wrap.querySelector(".extra-platform-remove")?.addEventListener("click", () => {
      const platform = readExtraPlatformForm(extraPlatformForm);
      if (!window.confirm(`确定删除 ${platform.name || "该平台"}、其全部模型和本地 API Key？删除结果将在重启 Codex 后生效。`)) return;
      enqueue({ type: "extra-platform-remove", platformId: platform.id });
    });
}

  return { renderExtraPlatformForm, renderDeepSeekModelPicker, renderExtraModelReasoning, readExtraPlatformForm, bindModelFormEvents };
}

export { createModelEditor };
