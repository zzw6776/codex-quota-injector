function createModelState(dependencies) {
  const { state } = dependencies;
  const patchPanelBalance = (...args) => dependencies.patchPanelBalance(...args);
  const renderManagedDeepSeekBalance = (...args) => dependencies.renderManagedDeepSeekBalance(...args);
  const renderExtraModelFeedback = (...args) => dependencies.renderExtraModelFeedback(...args);
  const renderExtraModelProgress = (...args) => dependencies.renderExtraModelProgress(...args);
  const renderDeepSeekModelPicker = (...args) => dependencies.renderDeepSeekModelPicker(...args);
  const renderExtraModelCardStatus = (...args) => dependencies.renderExtraModelCardStatus(...args);
  const renderExtraModelCompatibility = (...args) => dependencies.renderExtraModelCompatibility(...args);
  const renderExtraModelReasoning = (...args) => dependencies.renderExtraModelReasoning(...args);
  const readExtraPlatformForm = (...args) => dependencies.readExtraPlatformForm(...args);
  const enqueue = (...args) => dependencies.enqueue(...args);

function setExtraPlatformDraft(draft) {
    state.extraPlatformDraft = draft;
    if (draft) state.extraPlatformDrafts.set(draft.id, draft);
  }

function extraPlatformDisplayModels(platform) {
    return (state.extraPlatformDrafts.get(platform.id) ?? platform).models;
  }

function applyExtraModelDiscovery(extraModels) {
    const discovery = extraModels?.modelDiscovery;
    if (state.extraPlatformDraft?.preset !== "deepseek" ||
      discovery?.platformId !== state.extraPlatformDraft.id ||
      Number(discovery.revision) <= state.extraModelDiscoveryRevision) return false;
    state.extraModelDiscoveryRevision = Number(discovery.revision);
    setExtraPlatformDraft({
      ...state.extraPlatformDraft,
      models: Array.isArray(discovery.models)
        ? discovery.models.map((model) => ({
            ...model,
            compatibility: model.compatibility ? { ...model.compatibility } : { status: "pending" },
          }))
        : state.extraPlatformDraft.models,
      modelsUpdatedAt: discovery.modelsUpdatedAt ?? state.extraPlatformDraft.modelsUpdatedAt,
    });
    return true;
  }

function patchExtraModelsDom(extraModels, { clearDraftOperation = false } = {}) {
    const saving = state.extraPlatformSaveRequest;
    if (saving && extraModels?.platformSave?.requestId === saving.requestId) {
      const previousId = saving.draft.id;
      const draft = state.extraPlatformDrafts.get(previousId);
      if (draft) {
        const savedModels = JSON.parse(saving.snapshot);
        for (const model of draft.models) {
          if (savedModels.some(saved => saved.id === model.id && JSON.stringify(saved) === JSON.stringify(model))) {
            delete model.configurationUnsaved;
          }
        }
        state.extraPlatformDrafts.delete(previousId);
        draft.id = extraModels.platformSave.platformId;
        state.extraPlatformDrafts.set(draft.id, draft);
        for (const pending of state.extraModelDetectionRequests.values()) {
          if (pending.platformId === previousId) pending.platformId = draft.id;
        }
      }
      state.extraPlatformSaveRequest = null;
    }
    const discoveryChanged = applyExtraModelDiscovery(extraModels);
    const detectionIndices = applyExtraModelDetection(extraModels);
    state.data = { ...state.data, extraModels: extraModels ?? { platforms: [] } };
    if (clearDraftOperation) state.extraModelOperationDraft = null;
    const wrap = state.shadow?.querySelector(".quota-wrap");
    if (!wrap) return;
    patchPanelBalance(wrap);
    if (state.page !== "extra-models") return;
    const data = state.data.extraModels ?? {};
    const platforms = Array.isArray(data.platforms) ? data.platforms : [];
    const operation = data.operation ?? state.extraModelOperationDraft;
    const busy = operation?.state === "loading";
    const feedback = wrap.querySelector(".extra-model-feedback");
    if (feedback) feedback.innerHTML = renderExtraModelFeedback(data, operation);
    const pendingBadge = wrap.querySelector(".pending-restart");
    if (data.pendingRestart && !pendingBadge) {
      const status = wrap.querySelector(".provider-status");
      status?.insertAdjacentHTML("beforeend", '<span class="badge pending-restart">等待重启生效</span>');
    } else if (!data.pendingRestart) {
      pendingBadge?.remove();
    }
    wrap.querySelector(".extra-platform-add")?.toggleAttribute("disabled", busy);
    for (const card of wrap.querySelectorAll(".extra-platform-card")) {
      const platform = platforms.find((item) => item.id === card.dataset.platformId);
      if (!platform) continue;
      const progress = card.querySelector(".extra-platform-progress");
      if (progress) progress.innerHTML = renderPlatformDetectionProgress(platform, operation);
      const status = card.querySelector(".extra-platform-model-status");
      if (status) status.innerHTML = extraPlatformDisplayModels(platform)
        .map((model, index) => renderExtraModelCardStatus(model, index, modelDetectionOperation(model, platform.id)))
        .join("");
      if (platform.preset === "deepseek") {
        const balance = card.querySelector(".managed-deepseek-balance");
        if (balance) balance.outerHTML = renderManagedDeepSeekBalance(data, platform);
      }
      const meta = card.querySelector(".extra-platform-meta");
      if (meta) meta.textContent = `${platform.models.filter((model) => model.selected !== false).length} / ${platform.models.length} 个模型已选 · 可逐个检测或手动配置`;
      const edit = card.querySelector(".extra-platform-edit");
      if (edit) edit.disabled = data.supported === false;
    }
    const form = wrap.querySelector(".extra-platform-form");
    if (form && state.extraPlatformDraft) form.dataset.platformId = state.extraPlatformDraft.id;
    form?.querySelector('button[type="submit"]')?.toggleAttribute("disabled", busy);
    form?.querySelector(".preset-model-refresh")?.toggleAttribute("disabled", busy);
    if (discoveryChanged && state.extraPlatformDraft?.preset === "deepseek") {
      const picker = form?.querySelector(".preset-model-picker");
      if (picker) picker.outerHTML = renderDeepSeekModelPicker(state.extraPlatformDraft.models, !busy);
    }
    for (const detectionIndex of form ? detectionIndices : []) {
      const row = form.querySelector(`[data-model-index="${detectionIndex}"]`);
      const model = state.extraPlatformDraft.models[detectionIndex];
      if (row) {
        const status = row.querySelector(".extra-model-status");
        if (status) status.outerHTML = renderExtraModelCompatibility(model);
        const settings = row.querySelector(".extra-model-settings");
        if (settings && model.lastDetection?.status === "passed") {
          const open = settings.open;
          settings.outerHTML = renderExtraModelReasoning(model, !busy);
          row.querySelector(".extra-model-settings").open = open;
        }
      }
    }
    for (const row of form?.querySelectorAll("[data-model-index]") ?? []) {
      const status = row.querySelector(".extra-model-status");
      const model = state.extraPlatformDraft?.models[Number(row.dataset.modelIndex)];
      if (status && model) status.outerHTML = renderExtraModelCompatibility(model);
      const progress = row.querySelector(".extra-model-inline-progress");
      if (progress && model) progress.innerHTML = renderExtraModelProgress(modelDetectionOperation(model));
    }
    for (const input of form?.querySelectorAll("input, select, button") ?? []) {
      input.disabled = busy || input.classList.contains("extra-model-remove") && state.extraPlatformDraft?.models?.length <= 1;
    }
    bindExtraModelDetectButtons(wrap);
    bindManagedDeepSeekBalanceButtons(wrap);
  }

function applyExtraModelDetection(extraModels) {
    const changed = [];
    for (const result of extraModels?.modelDetections ?? []) {
      if (result.status === "loading") continue;
      const pending = state.extraModelDetectionRequests.get(result.requestId);
      if (!pending) continue;
      state.extraModelDetectionRequests.delete(result.requestId);
      const draft = state.extraPlatformDrafts.get(pending.platformId);
      if (!draft || draft.baseUrl !== pending.baseUrl || draft.apiKey !== pending.apiKey) continue;
      const index = draft.models.findIndex(model => model.id === pending.modelId);
      const model = draft.models[index];
      if (!model) continue;
      draft.models[index] = { ...model, ...(result.model ? {
        compatibility: result.model.compatibility,
        reasoningEfforts: result.model.reasoningEfforts,
        defaultReasoningEffort: result.model.defaultReasoningEffort,
      } : {}), lastDetection: result,
        configurationUnsaved: result.status === "passed" || model.configurationUnsaved };
      if (draft === state.extraPlatformDraft) changed.push(index);
    }
    return changed;
  }

function forgetModelDetection(platformId, modelId = null) {
    for (const [id, pending] of state.extraModelDetectionRequests) {
      if (pending.platformId === platformId && (modelId == null || pending.modelId === modelId)) {
        state.extraModelDetectionRequests.delete(id);
      }
    }
  }

function bindExtraModelDetectButtons(scope) {
    for (const button of scope.querySelectorAll(".extra-model-detect")) {
      if (button.dataset.bound === "true") continue;
      button.dataset.bound = "true";
      button.addEventListener("click", () => {
        const form = button.closest("form");
        if (!form) return;
        const draft = readExtraPlatformForm(form);
        const index = Number(button.closest("[data-model-index]").dataset.modelIndex);
        const model = draft.models[index];
        if (!model?.id || !draft.apiKey || !draft.baseUrl) {
          const feedback = scope.querySelector(".extra-model-feedback");
          if (feedback) feedback.innerHTML = '<div class="operation error">检测前请填写模型 ID、API 地址和 Key</div>';
          return;
        }
        const requestId = crypto.randomUUID();
        setExtraPlatformDraft(draft);
        forgetModelDetection(draft.id, model.id);
        state.extraModelDetectionRequests.set(requestId, { requestId, platformId: draft.id, modelId: model.id,
          baseUrl: draft.baseUrl, apiKey: draft.apiKey,
          operation: { state: "loading", phase: "detecting", platformId: draft.id, modelId: model.id,
            message: `正在检测 ${model.displayName || model.id}` } });
        enqueue({ type: "extra-model-detect", platform: draft, modelId: model.id, requestId });
        patchExtraModelsDom(state.data.extraModels);
      });
    }
  }

function showExtraModelOperation({ message, platformId = null, modelId = null, phase = "starting" }) {
    state.extraModelOperationDraft = { state: "loading", message, platformId, modelId, phase };
    patchExtraModelsDom(state.data.extraModels);
  }

function bindManagedDeepSeekBalanceButtons(scope) {
    for (const button of scope.querySelectorAll(".extra-deepseek-refresh-balance")) {
      if (button.dataset.bound === "true") continue;
      button.dataset.bound = "true";
      button.addEventListener("click", () => enqueue({ type: "extra-deepseek-refresh-balance" }));
    }
  }

function modelDetectionOperation(model, platformId = state.extraPlatformDraft?.id) {
    const pending = [...state.extraModelDetectionRequests.values()].find(item =>
      item.platformId === platformId && item.modelId === model.id);
    const detection = (state.data.extraModels?.modelDetections ?? []).find(item => pending
      ? item.requestId === pending.requestId
      : item.platformId === platformId && item.modelId === model.id);
    return detection ? detection.operation : pending?.operation ?? null;
  }

function renderPlatformDetectionProgress(platform, operation) {
    return (operation?.platformId === platform.id ? renderExtraModelProgress(operation) : "") +
      extraPlatformDisplayModels(platform).map(model =>
        renderExtraModelProgress(modelDetectionOperation(model, platform.id))).join("");
  }

function renderModelDetectionProgress(model) {
    return `<div class="extra-model-inline-progress" aria-live="polite">${renderExtraModelProgress(modelDetectionOperation(model))}</div>`;
  }

  return { setExtraPlatformDraft, extraPlatformDisplayModels, applyExtraModelDiscovery, patchExtraModelsDom, applyExtraModelDetection, forgetModelDetection, bindExtraModelDetectButtons, showExtraModelOperation, bindManagedDeepSeekBalanceButtons, modelDetectionOperation, renderPlatformDetectionProgress, renderModelDetectionProgress };
}

export { createModelState };
