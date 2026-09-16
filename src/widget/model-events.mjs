function createModelEvents(dependencies) {
  const { state } = dependencies;
  const render = (...args) => dependencies.render(...args);
  const setExtraPlatformDraft = (...args) => dependencies.setExtraPlatformDraft(...args);
  const forgetModelDetection = (...args) => dependencies.forgetModelDetection(...args);
  const bindExtraModelDetectButtons = (...args) => dependencies.bindExtraModelDetectButtons(...args);
  const showExtraModelOperation = (...args) => dependencies.showExtraModelOperation(...args);
  const bindManagedDeepSeekBalanceButtons = (...args) => dependencies.bindManagedDeepSeekBalanceButtons(...args);
  const renderExtraModelCompatibility = (...args) => dependencies.renderExtraModelCompatibility(...args);
  const blankExtraModel = (...args) => dependencies.blankExtraModel(...args);
  const readExtraPlatformForm = (...args) => dependencies.readExtraPlatformForm(...args);
  const enqueue = (...args) => dependencies.enqueue(...args);

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

  return { bindModelFormEvents };
}

export { createModelEvents };
