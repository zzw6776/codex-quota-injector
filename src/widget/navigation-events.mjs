function createNavigationEvents(dependencies) {
  const { state } = dependencies;
  const render = (...args) => dependencies.render(...args);
  const setExtraPlatformDraft = (...args) => dependencies.setExtraPlatformDraft(...args);
  const captureDetailPanelBaseSize = (...args) => dependencies.captureDetailPanelBaseSize(...args);
  const resetDetailPanelSize = (...args) => dependencies.resetDetailPanelSize(...args);

function bindModelNavigation(wrap) {
wrap.querySelector(".context-open")?.addEventListener("click", () => {
      captureDetailPanelBaseSize(wrap);
      state.page = "context";
      state.contextEditingSlug = null;
      state.pinned = true;
      state.dismissed = false;
      render();
    });
wrap.querySelector(".extra-models-open")?.addEventListener("click", () => {
      captureDetailPanelBaseSize(wrap);
      state.page = "extra-models";
      setExtraPlatformDraft(null);
      state.extraModelOperationDraft = null;
      state.pinned = true;
      state.dismissed = false;
      render();
    });
wrap.querySelector(".context-back")?.addEventListener("click", () => {
      state.page = "accounts";
      resetDetailPanelSize();
      state.contextEditingSlug = null;
      render();
    });
wrap.querySelector(".extra-models-back")?.addEventListener("click", () => {
      if (state.extraPlatformDraft) {
        setExtraPlatformDraft(null);
      } else {
        state.page = "accounts";
        resetDetailPanelSize();
      }
      state.extraModelOperationDraft = null;
      render();
    });
}

  return { bindModelNavigation };
}

export { createNavigationEvents };
