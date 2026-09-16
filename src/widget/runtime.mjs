import { WIDGET_RUNTIME_VERSION } from "./contract.mjs";
import { paginateGenerationDetails, formatGenerationDetailTitle, formatGenerationPhaseText, generationToolRows, generationExecutionRemainder, formatGenerationPrimaryText, averageGenerationNetworkLatency } from "./generation-display.mjs";
import { createGenerationToolRow } from "./generation-display.mjs";
import { selectConversationNetworkLatency, formatNetworkLatencyText, formatConversationUsageSummary } from "./usage-display.mjs";
import { calculateScrollbarEndPadding } from "./layout-display.mjs";
import { WIDGET_FEATURES } from "./browser-features.mjs";
import { WIDGET_STYLES } from "./styles.mjs";

function installQuotaWidget(
  calculateMaxHeight = (chipTop) => Math.max(0, Math.min(720, Math.floor(Number(chipTop) - 54))),
  runtimeVersion = WIDGET_RUNTIME_VERSION,
  paginateDetails = paginateGenerationDetails,
  detailTitle = formatGenerationDetailTitle,
  phaseText = formatGenerationPhaseText,
  primaryText = formatGenerationPrimaryText,
  usageSummaryText = formatConversationUsageSummary,
  selectNetworkLatency = selectConversationNetworkLatency,
  networkLatencyText = formatNetworkLatencyText,
  averageNetworkLatency = averageGenerationNetworkLatency,
  toolRows = generationToolRows,
  toolRowElement = createGenerationToolRow,
  executionRemainder = generationExecutionRemainder,
  scrollbarEndPadding = calculateScrollbarEndPadding,
  features = WIDGET_FEATURES,
  styles = WIDGET_STYLES,
) {
  const GLOBAL_KEY = "__codexQuotaWidget";
  const ROOT_ID = "codex-quota-injector-root";
  const GLOBAL_STYLE_ID = "codex-quota-injector-global-style";
  const VERSION = runtimeVersion;
  const MAX_CONVERSATION_USAGE_CACHE = 240;
  const CONVERSATION_TOOLTIP_DELAY_MS = 500;
  const ACCOUNT_TOOLTIP_DELAY_MS = 300;
  const CUSTOM_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
  if (window[GLOBAL_KEY]?.version === VERSION) return VERSION;
  try {
    window[GLOBAL_KEY]?.destroy?.();
  } catch {
    document.getElementById(ROOT_ID)?.remove();
    document.getElementById(GLOBAL_STYLE_ID)?.remove();
    delete window[GLOBAL_KEY];
  }

  const globalStyleText = styles.globalStyleText;

  function ensureGlobalStyle() {
    let style = document.getElementById(GLOBAL_STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = GLOBAL_STYLE_ID;
      (document.head ?? document.documentElement).append(style);
    }
    if (style.textContent !== globalStyleText) {
      style.textContent = globalStyleText;
    }
  }

  const state = {
    data: {
      accounts: [],
      windows: [],
      injectionMode: null,
      currentAccountId: null,
      operation: null,
      context: { status: "unavailable", models: [], overriddenCount: 0 },
      extraModels: { platforms: [] },
      tokenUsage: { status: "ready", turns: [] },
      hostHealth: { required: false, status: "direct" },
    },
    dataJson: "",
    dataRevision: null,
    tokenUsageRevision: null,
    root: null,
    shadow: null,
    observer: null,
    resizeHandler: null,
    documentPointerHandler: null,
    pinned: false,
    dismissed: false,
    actions: [],
    page: "accounts",
    migrationMode: "temporary",
    migrationSelectedIds: new Set(),
    wakeupDrafts: new Map(),
    accountTooltipTimer: null,
    contextEditingSlug: null,
    extraPlatformDraft: null,
    extraPlatformDrafts: new Map(),
    extraModelDiscoveryRevision: 0,
    extraModelDetectionRequests: new Map(),
    extraPlatformSaveRequest: null,
    panelScrollPosition: null,
    extraModelOperationDraft: null,
    detailPanelBaseSize: null,
    detailPanelSize: null,
    detailPanelResize: null,
    detailPanelResizeCleanup: null,
    conversationRenderFrame: null,
    conversationTooltip: null,
    conversationTooltipBridge: null,
    conversationTooltipTimer: null,
    conversationTooltipPendingLine: null,
    conversationTooltipPendingPointer: null,
    conversationTooltipTarget: null,
    conversationTooltipPointer: null,
    conversationUsageByTurn: new Map(),
    conversationTurnNodes: new Map(),
    conversationUsageLines: new Map(),
    conversationDomDirty: true,
    conversationObserverRoot: null,
    mountObserver: null,
    mountCheckFrame: null,
  };

  const conversationTurnSelector = "[data-content-search-turn-key]";

  const { currentDeepSeekBalanceView, renderPanelBalance, patchPanelBalance } = features.balance({
    get state() { return state; },
    get escapeHtml() { return escapeHtml; },
  });

  const { renderHostHealthBanner, renderPanelControls, renderHostHealthStatus, hostToolLabel } = features.host_health({
    get state() { return state; },
    get formatUpdatedAt() { return formatUpdatedAt; },
    get escapeHtml() { return escapeHtml; },
  });

  const { scheduleConversationTokenUsageRender, placeConversationTokenUsageLine, renderConversationTokenUsage, conversationSubagentLabel } = features.usage_lines({
    get usageSummaryText() { return usageSummaryText; },
    get selectNetworkLatency() { return selectNetworkLatency; },
    get MAX_CONVERSATION_USAGE_CACHE() { return MAX_CONVERSATION_USAGE_CACHE; },
    get state() { return state; },
    get showConversationTokenTooltip() { return showConversationTokenTooltip; },
    get scheduleConversationTokenTooltip() { return scheduleConversationTokenTooltip; },
    get moveConversationTokenTooltip() { return moveConversationTokenTooltip; },
    get isConversationTooltipArea() { return isConversationTooltipArea; },
    get hideConversationTokenTooltip() { return hideConversationTokenTooltip; },
    get formatTokenCount() { return formatTokenCount; },
    get bindConversationObserver() { return bindConversationObserver; },
  });

  const { showConversationTokenTooltip, appendConversationTooltipRow, appendConversationTooltipSummaryRow, appendConversationTooltipMetricRow, summarizeConversationTooltipInput, getConversationTooltipTiers, normalizeTooltipUsage } = features.usage_tooltip({
    get state() { return state; },
    get conversationTooltipPointer() { return conversationTooltipPointer; },
    get appendGenerationDetails() { return appendGenerationDetails; },
    get syncConversationScrollbarPadding() { return syncConversationScrollbarPadding; },
    get conversationSubagentLabel() { return conversationSubagentLabel; },
    get formatContextTier() { return formatContextTier; },
    get formatUnitPrice() { return formatUnitPrice; },
    get ensureConversationTokenTooltip() { return ensureConversationTokenTooltip; },
    get positionConversationTokenTooltip() { return positionConversationTokenTooltip; },
    get clearConversationTooltipTimer() { return clearConversationTooltipTimer; },
    get isLightTheme() { return isLightTheme; },
    get formatTokenCount() { return formatTokenCount; },
    get formatCny() { return formatCny; },
    get formatTooltipPercent() { return formatTooltipPercent; },
    get formatExchangeRate() { return formatExchangeRate; },
  });

  const { scheduleConversationTokenTooltip, moveConversationTokenTooltip, conversationTooltipPointer, ensureConversationTokenTooltip, positionConversationTokenTooltip, positionConversationTooltipBridge, isConversationTooltipTarget, isConversationBridgeTarget, isConversationTooltipArea, isConversationLineTarget, hideConversationTokenTooltip, clearConversationTooltipTimer } = features.tooltip_position({
    get CONVERSATION_TOOLTIP_DELAY_MS() { return CONVERSATION_TOOLTIP_DELAY_MS; },
    get state() { return state; },
    get showConversationTokenTooltip() { return showConversationTokenTooltip; },
  });

  const { appendGenerationDetails, syncConversationScrollbarPadding } = features.usage_details({
    get paginateDetails() { return paginateDetails; },
    get detailTitle() { return detailTitle; },
    get phaseText() { return phaseText; },
    get primaryText() { return primaryText; },
    get networkLatencyText() { return networkLatencyText; },
    get averageNetworkLatency() { return averageNetworkLatency; },
    get toolRows() { return toolRows; },
    get toolRowElement() { return toolRowElement; },
    get executionRemainder() { return executionRemainder; },
    get scrollbarEndPadding() { return scrollbarEndPadding; },
    get formatGenerationRate() { return formatGenerationRate; },
    get formatFirstTokenLatency() { return formatFirstTokenLatency; },
    get formatMetricDuration() { return formatMetricDuration; },
  });

  const { formatContextTier, formatUnitPrice, isLightTheme, formatReset, formatExpiry, formatUpdatedAt, formatPlan, levelClass, formatContextValue, contextTokensToK, contextKToTokens, formatTokenCount, formatGenerationRate, formatFirstTokenLatency, formatMetricDuration, formatCny, formatTooltipPercent, formatExchangeRate, number, escapeHtml } = features.formatting({

  });

  const { renderContextPage, renderContextModel, renderContextEditForm, bindContextEvents, setContextEditorOpen } = features.context({
    get state() { return state; },
    get renderPanelControls() { return renderPanelControls; },
    get enqueue() { return enqueue; },
    get formatContextValue() { return formatContextValue; },
    get escapeHtml() { return escapeHtml; },
  });

  const { renderManagedDeepSeekBalance, renderExtraModelsPage, renderExtraModelFeedback, renderExtraModelProgress, extraModelStatus, renderExtraModelCardStatus, renderExtraModelStatusBadge, renderExtraModelCompatibility, renderExtraModelConfiguration } = features.model_views({
    get CUSTOM_REASONING_EFFORTS() { return CUSTOM_REASONING_EFFORTS; },
    get state() { return state; },
    get renderPanelControls() { return renderPanelControls; },
    get extraPlatformDisplayModels() { return extraPlatformDisplayModels; },
    get modelDetectionOperation() { return modelDetectionOperation; },
    get renderPlatformDetectionProgress() { return renderPlatformDetectionProgress; },
    get renderExtraPlatformForm() { return renderExtraPlatformForm; },
    get formatUpdatedAt() { return formatUpdatedAt; },
    get escapeHtml() { return escapeHtml; },
  });

  const { setExtraPlatformDraft, extraPlatformDisplayModels, applyExtraModelDiscovery, patchExtraModelsDom, applyExtraModelDetection, forgetModelDetection, bindExtraModelDetectButtons, showExtraModelOperation, bindManagedDeepSeekBalanceButtons, modelDetectionOperation, renderPlatformDetectionProgress, renderModelDetectionProgress } = features.model_state({
    get patchPanelBalance() { return patchPanelBalance; },
    get state() { return state; },
    get renderManagedDeepSeekBalance() { return renderManagedDeepSeekBalance; },
    get renderExtraModelFeedback() { return renderExtraModelFeedback; },
    get renderExtraModelProgress() { return renderExtraModelProgress; },
    get renderDeepSeekModelPicker() { return renderDeepSeekModelPicker; },
    get renderExtraModelCardStatus() { return renderExtraModelCardStatus; },
    get renderExtraModelCompatibility() { return renderExtraModelCompatibility; },
    get renderExtraModelReasoning() { return renderExtraModelReasoning; },
    get readExtraPlatformForm() { return readExtraPlatformForm; },
    get enqueue() { return enqueue; },
  });

  const { renderExtraPlatformForm, renderDeepSeekPresetForm, renderDeepSeekModelPicker, renderExtraModelReasoning, readExtraModelSettings, blankExtraModel, readExtraPlatformForm } = features.model_forms({
    get state() { return state; },
    get renderModelDetectionProgress() { return renderModelDetectionProgress; },
    get renderExtraModelCompatibility() { return renderExtraModelCompatibility; },
    get formatUpdatedAt() { return formatUpdatedAt; },
    get contextTokensToK() { return contextTokensToK; },
    get contextKToTokens() { return contextKToTokens; },
    get escapeHtml() { return escapeHtml; },
  });

  const { positionPopover, captureDetailPanelBaseSize, resetDetailPanelSize, cancelDetailPanelResize, detailPanelBounds, applyDetailPanelSize, bindDetailPanelResize, dismissPanel } = features.panel_layout({
    get calculateMaxHeight() { return calculateMaxHeight; },
    get state() { return state; },
    get hideAccountTooltip() { return hideAccountTooltip; },
  });

  const { renderMigrationPage, bindMigrationEvents } = features.migration({
    get state() { return state; },
    get render() { return render; },
    get renderPanelControls() { return renderPanelControls; },
    get captureDetailPanelBaseSize() { return captureDetailPanelBaseSize; },
    get resetDetailPanelSize() { return resetDetailPanelSize; },
    get enqueue() { return enqueue; },
    get formatPlan() { return formatPlan; },
    get escapeHtml() { return escapeHtml; },
  });

  const { renderWakeupPage, renderWakeupAccount, renderWakeupStatus, readWakeupForm, bindWakeupNavigation, bindWakeupFormEvents } = features.wakeup({
    get state() { return state; },
    get render() { return render; },
    get renderPanelControls() { return renderPanelControls; },
    get captureDetailPanelBaseSize() { return captureDetailPanelBaseSize; },
    get resetDetailPanelSize() { return resetDetailPanelSize; },
    get enqueue() { return enqueue; },
    get formatUpdatedAt() { return formatUpdatedAt; },
    get escapeHtml() { return escapeHtml; },
  });

  const { renderAccount, renderWindow, bindAccountEvents } = features.accounts({
    get state() { return state; },
    get renderWakeupStatus() { return renderWakeupStatus; },
    get enqueue() { return enqueue; },
    get formatReset() { return formatReset; },
    get formatExpiry() { return formatExpiry; },
    get formatUpdatedAt() { return formatUpdatedAt; },
    get formatPlan() { return formatPlan; },
    get levelClass() { return levelClass; },
    get number() { return number; },
    get escapeHtml() { return escapeHtml; },
  });

  const { hideAccountTooltip, scheduleAccountTooltip } = features.account_tooltip({
    get ACCOUNT_TOOLTIP_DELAY_MS() { return ACCOUNT_TOOLTIP_DELAY_MS; },
    get state() { return state; },
  });

  const { bindGeneralEvents, bindPanelEvents } = features.panel_events({
    get state() { return state; },
    get positionPopover() { return positionPopover; },
    get hideAccountTooltip() { return hideAccountTooltip; },
    get scheduleAccountTooltip() { return scheduleAccountTooltip; },
    get bindDetailPanelResize() { return bindDetailPanelResize; },
    get enqueue() { return enqueue; },
    get dismissPanel() { return dismissPanel; },
  });

  const { bindModelNavigation } = features.navigation_events({
    get state() { return state; },
    get render() { return render; },
    get setExtraPlatformDraft() { return setExtraPlatformDraft; },
    get captureDetailPanelBaseSize() { return captureDetailPanelBaseSize; },
    get resetDetailPanelSize() { return resetDetailPanelSize; },
  });

  const { bindModelFormEvents } = features.model_events({
    get state() { return state; },
    get render() { return render; },
    get setExtraPlatformDraft() { return setExtraPlatformDraft; },
    get forgetModelDetection() { return forgetModelDetection; },
    get bindExtraModelDetectButtons() { return bindExtraModelDetectButtons; },
    get showExtraModelOperation() { return showExtraModelOperation; },
    get bindManagedDeepSeekBalanceButtons() { return bindManagedDeepSeekBalanceButtons; },
    get renderExtraModelCompatibility() { return renderExtraModelCompatibility; },
    get blankExtraModel() { return blankExtraModel; },
    get readExtraPlatformForm() { return readExtraPlatformForm; },
    get enqueue() { return enqueue; },
  });

  const { findConversationObserverRoot, bindConversationObserver, mutationTouchesConversation } = features.conversation_observer({
    get state() { return state; },
    get conversationTurnSelector() { return conversationTurnSelector; },
  });

  const styleText = styles.styleText;

  function findProfileButton() {
    const buttons = document.querySelectorAll("button[aria-label]");
    for (const button of buttons) {
      const label = button.getAttribute("aria-label") ?? "";
      if (
        /open profile menu/i.test(label) || /打开.*个人.*菜单/.test(label) ||
        /開啟.*個人.*選單/.test(label) || /open settings/i.test(label) ||
        /打开设置/.test(label) || /開啟設定/.test(label)
      ) return button;
    }
    return null;
  }

  function ensureMounted() {
    ensureGlobalStyle();
    const profileButton = findProfileButton();
    const profileRow = profileButton?.parentElement;
    if (!profileRow) {
      detachRoot();
      return false;
    }
    if (state.root?.isConnected && state.root.parentElement === profileRow) {
      const wrap = state.shadow?.querySelector(".quota-wrap");
      wrap?.classList.toggle("is-light", isLightTheme());
      if (wrap) positionPopover(wrap);
      return true;
    }
    detachRoot();
    document.getElementById(ROOT_ID)?.remove();
    const root = document.createElement("span");
    root.id = ROOT_ID;
    root.style.marginLeft = "auto";
    root.setAttribute("data-codex-quota-injector", `v${VERSION}`);
    const shadow = root.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = styleText;
    const wrap = document.createElement("span");
    wrap.className = "quota-wrap";
    shadow.append(style, wrap);
    profileButton.after(root);
    state.root = root;
    state.shadow = shadow;
    render();
    return true;
  }

  function detachRoot() {
    if (!state.root) return;
    dismissPanel();
    state.root.remove();
    state.root = null;
    state.shadow = null;
  }

  function render() {
    const wrap = state.shadow?.querySelector(".quota-wrap");
    if (!wrap) return;
    cancelDetailPanelResize();
    hideAccountTooltip();
    const previousScroller = wrap.querySelector(".panel-scroll");
    const retainedScroll = state.panelScrollPosition?.page === state.page ? state.panelScrollPosition : null;
    const previousScrollTop = state.dismissed ? retainedScroll?.top ?? 0 : previousScroller?.scrollTop ?? retainedScroll?.top ?? 0;
    const previousScrollLeft = state.dismissed ? retainedScroll?.left ?? 0 : previousScroller?.scrollLeft ?? retainedScroll?.left ?? 0;
    const wakeupFocus = state.shadow.activeElement?.closest?.(".wakeup-popover")
      ? state.shadow.activeElement.id : null;
    wrap.classList.toggle("is-light", isLightTheme());
    wrap.classList.toggle("is-open", state.pinned);
    wrap.classList.toggle("is-dismissed", state.dismissed);
    const accounts = Array.isArray(state.data.accounts) ? state.data.accounts : [];
    const currentAccount = accounts.find((a) => a.current) ?? accounts[0] ?? null;
    const currentCredits = currentAccount?.credits ?? state.data.credits ?? null;
    const hasPositiveBalance = Boolean(
      currentCredits && (
        currentCredits.unlimited ||
        (Number(currentCredits.usdAmount) > 0) ||
        (Number(currentCredits.creditQuantity) > 0)
      )
    );
    const chipBalanceText = hasPositiveBalance
      ? (currentCredits.unlimited
          ? "无限"
          : (currentCredits.formattedUsd ?? (Number.isFinite(currentCredits.creditQuantity) ? `${currentCredits.creditQuantity} 点` : "")))
      : "";
    const windows = Array.isArray(state.data.windows) ? state.data.windows : [];
    const chipItems = [];
    if (windows.length) {
      chipItems.push(...windows.map((quota) => `<span class="quota-chip-item ${levelClass(quota.remainingPercent)}">${number(quota.remainingPercent)}%</span>`));
    } else {
      chipItems.push('<span class="quota-chip-item">--</span>');
    }
    if (chipBalanceText) {
      chipItems.push(`<span class="quota-chip-item quota-chip-balance">${escapeHtml(chipBalanceText)}</span>`);
    }
    const hostHealth = state.data.hostHealth ?? { required: false, status: "direct" };
    const healthIndicator = hostHealth.status === "degraded"
      ? '<span class="host-health-dot degraded" aria-hidden="true"></span>'
      : hostHealth.status === "starting"
        ? '<span class="host-health-dot" aria-hidden="true"></span>'
        : "";
    const chip = `${healthIndicator}${chipItems.join('<span class="quota-divider">·</span>')}`;
    const hostHealthBanner = renderHostHealthBanner(hostHealth);
    const accountHtml = accounts.length
      ? accounts.map(renderAccount).join("")
      : '<div class="empty">暂无账号，点击下方按钮添加</div>';
    const oauthCancellable =
      state.data.operation?.state === "loading" &&
      state.data.operation?.cancellable === "oauth";
    const operation = state.data.operation
      ? `<div class="operation ${escapeHtml(state.data.operation.state)} ${oauthCancellable ? "has-action" : ""}"><span>${escapeHtml(state.data.operation.message)}</span>${oauthCancellable ? '<button class="btn oauth-cancel" type="button">取消授权</button>' : ""}</div>`
      : "";
    const busy = state.data.operation?.state === "loading";
    const contextPage = state.page === "context";
    const extraModelsPage = state.page === "extra-models";
    const wakeupPage = state.page === "wakeup";
    const migrationPage = state.page === "migration";
    const appVersion = state.data.version ? escapeHtml(String(state.data.version)) : "";
    const injectionRuntime = state.data.injectionMode === "wsl"
      ? { label: "WSL", title: "注入运行时：WSL" }
      : state.data.injectionMode === "windows"
        ? { label: "Windows", title: "注入运行时：Windows" }
        : null;
    const balanceHtml = renderPanelBalance();
    const popoverClass = contextPage
      ? "quota-popover detail-popover context-popover"
      : wakeupPage
        ? "quota-popover detail-popover wakeup-popover"
      : migrationPage
        ? "quota-popover detail-popover migration-popover"
      : extraModelsPage
          ? "quota-popover detail-popover extra-models-popover"
        : "quota-popover";
    const popoverContent = contextPage
      ? renderContextPage(busy)
      : wakeupPage
        ? renderWakeupPage(busy)
      : migrationPage
        ? renderMigrationPage(accounts, busy, operation)
      : extraModelsPage
          ? renderExtraModelsPage()
        : `
        <header class="panel-head accounts-head">
          <div class="panel-title-wrap">
            <div class="panel-title">账号额度<span class="panel-count">${accounts.length} 个账号</span></div>
            <button class="icon-btn provider-icon-btn extra-models-open" type="button" aria-label="模型管理" title="模型管理"><span aria-hidden="true">M+</span></button>
            <button class="icon-btn provider-icon-btn context-open" type="button" aria-label="模型上下文" title="模型上下文"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10.3 2.2h3.4l.5 2.6 3 1.7 2.5-.9 1.7 2.9-2 1.8v3.4l2 1.8-1.7 2.9-2.5-.9-3 1.7-.5 2.6h-3.4l-.5-2.6-3-1.7-2.5.9-1.7-2.9 2-1.8v-3.4l-2-1.8 1.7-2.9 2.5.9 3-1.7Z"/><circle cx="12" cy="12" r="3"/></svg></button>
            <button class="icon-btn provider-icon-btn wakeup-open" type="button" aria-label="定时任务" title="定时任务"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><path d="M12 6v6h6"/></svg></button>
          </div>
          ${renderPanelControls(hostHealth)}
        </header>
        <div class="account-list">${accountHtml}</div>
        ${operation}
        <section class="add-panel">
          <div class="add-toolbar"><span class="add-title">账号管理</span><span class="toolbar-actions"><button class="btn migration-open" type="button" ${busy || accounts.length === 0 ? "disabled" : ""}>迁移账号</button><button class="btn refresh-all" type="button" ${busy ? "disabled" : ""}>刷新全部</button></span></div>
          <div class="add-options">
            <button class="btn primary oauth-add" type="button" ${busy ? "disabled" : ""}>OpenAI OAuth</button>
            <button class="btn local-import" type="button" ${busy ? "disabled" : ""}>导入本机登录</button>
            <details><summary>Token / JSON</summary><form class="token-form"><textarea name="token" autocomplete="off" placeholder="粘贴迁移 JSON、auth.json、access token 或 refresh token" required ${busy ? "disabled" : ""}></textarea><button class="btn primary" type="submit" ${busy ? "disabled" : ""}>解析并导入</button></form></details>
            <details><summary>API Key</summary><form class="api-key-form"><input name="name" placeholder="账号名称（可选）" ${busy ? "disabled" : ""}><input name="apiKey" type="password" autocomplete="off" placeholder="OpenAI API Key" required ${busy ? "disabled" : ""}><button class="btn primary" type="submit" ${busy ? "disabled" : ""}>添加 API Key</button></form></details>
          </div>
        </section>`;
    const footerMeta = [injectionRuntime?.label, appVersion ? `v${appVersion}` : ""]
      .filter(Boolean)
      .join(" · ");
    const footerTitle = injectionRuntime?.title ? ` title="${injectionRuntime.title}"` : "";
    const versionFooter = footerMeta
      ? `<div class="panel-version">${balanceHtml}<span class="panel-version-text"${footerTitle}>${footerMeta}</span></div>`
      : "";
    wrap.innerHTML = `
      <button class="quota-chip" type="button" aria-label="${hostHealth.status === "degraded" ? "Codex 任务工具异常；查看账号额度与诊断" : "查看账号额度"}">${chip}</button>
      <section class="${popoverClass}" popover="manual" aria-label="${contextPage ? "Codex 模型上下文" : wakeupPage ? "账号定时唤醒" : migrationPage ? "账号迁移" : extraModelsPage ? "模型管理" : "Codex 账号与额度"}"><div class="panel-scroll">${hostHealthBanner}${popoverContent}${versionFooter}</div></section>`;
    const nextPopover = wrap.querySelector(".quota-popover");
    if (nextPopover) {
      const nextScroller = nextPopover.querySelector(".panel-scroll");
      const header = nextScroller.querySelector(".panel-head");
      if (header) nextPopover.prepend(header);
      nextPopover.showPopover();
      nextScroller.scrollTop = previousScrollTop;
      nextScroller.scrollLeft = previousScrollLeft;
    }
    positionPopover(wrap);
    bindEvents(wrap);
    if (wakeupFocus) state.shadow.getElementById(wakeupFocus)?.focus({ preventScroll: true });
    scheduleConversationTokenUsageRender();
  }

  function bindEvents(wrap) {
    bindGeneralEvents(wrap);
    bindWakeupNavigation(wrap);
    bindMigrationEvents(wrap);
    bindWakeupFormEvents(wrap);
    bindPanelEvents(wrap);
    bindModelNavigation(wrap);
    bindModelFormEvents(wrap);
    bindContextEvents(wrap);
    bindAccountEvents(wrap);
  }

  function enqueue(action) {
    state.actions.push({ ...action, id: `${Date.now()}-${Math.random().toString(16).slice(2)}` });
    state.dismissed = false;
    state.pinned = true;
  }

  state.observer = new MutationObserver((mutations) => {
    if (mutationTouchesConversation(mutations)) {
      state.conversationDomDirty = true;
      scheduleConversationTokenUsageRender();
    }
  });
  state.mountObserver = new MutationObserver((mutations) => {
    if (mutationTouchesConversation(mutations)) {
      state.conversationDomDirty = true;
      scheduleConversationTokenUsageRender();
    }
    if (state.mountCheckFrame != null) return;
    state.mountCheckFrame = window.requestAnimationFrame(() => {
      state.mountCheckFrame = null;
      if (!state.root?.isConnected) ensureMounted();
      const firstTurn = document.querySelector(conversationTurnSelector);
      if (firstTurn && state.conversationObserverRoot?.isConnected &&
        !state.conversationObserverRoot.contains(firstTurn)) {
        state.observer?.disconnect();
        state.conversationObserverRoot = null;
        state.conversationDomDirty = true;
      }
      if (!state.conversationObserverRoot?.isConnected) {
        state.conversationDomDirty = true;
        scheduleConversationTokenUsageRender();
      }
    });
  });
  state.mountObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-content-search-turn-key"],
  });
  // Theme changes need no data revision and must not rebuild an active form.
  const themeQuery = window.matchMedia?.("(prefers-color-scheme: light)");
  const syncTheme = () => ensureMounted();
  const themeObserver = new MutationObserver(syncTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  themeQuery?.addEventListener("change", syncTheme);
  state.resizeHandler = () => {
    hideAccountTooltip();
    const wrap = state.shadow?.querySelector(".quota-wrap");
    if (wrap) positionPopover(wrap);
    if (state.conversationTooltipTarget) {
      positionConversationTokenTooltip(state.conversationTooltipTarget);
    }
  };
  state.documentPointerHandler = (event) => {
    if (state.root && event.composedPath().includes(state.root)) return;
    if (state.conversationTooltip && event.composedPath().includes(state.conversationTooltip)) return;
    if (state.conversationTooltipBridge && event.composedPath().includes(state.conversationTooltipBridge)) return;
    dismissPanel();
  };
  window.addEventListener("resize", state.resizeHandler);
  document.addEventListener("pointerdown", state.documentPointerHandler, true);
  ensureMounted();

  window[GLOBAL_KEY] = {
    version: VERSION,
    update(data, revision = null) {
      const json = revision == null ? JSON.stringify(data ?? {}) : `revision:${revision}`;
      if (revision != null && revision === state.dataRevision) return;
      if (json === state.dataJson) return;
      const patchOpenExtraModelsPage = state.page === "extra-models" &&
        Boolean(state.shadow?.querySelector(".extra-models-popover"));
      state.dataJson = json;
      state.dataRevision = revision;
      state.tokenUsageRevision = revision;
      state.data = data ?? state.data;
      ensureMounted();
      patchExtraModelsDom(data?.extraModels, { clearDraftOperation: true });
      if (patchOpenExtraModelsPage) {
        scheduleConversationTokenUsageRender();
        return;
      }
      render();
    },
    updateExtraModels(extraModels, revision = null) {
      if (revision != null && revision === state.dataRevision) return;
      state.dataRevision = revision;
      ensureMounted();
      patchExtraModelsDom(extraModels, { clearDraftOperation: true });
    },
    updateTokenUsage(tokenUsage, revision = null) {
      if (revision != null && revision === state.tokenUsageRevision) return;
      state.tokenUsageRevision = revision;
      state.data = { ...state.data, tokenUsage: tokenUsage ?? { status: "ready", turns: [] } };
      ensureMounted();
      scheduleConversationTokenUsageRender();
    },
    updateTokenUsageDelta(delta, revision = null) {
      if (revision != null && revision === state.tokenUsageRevision) return;
      const current = state.data.tokenUsage ?? { status: "ready", turns: [] };
      const turnsById = new Map(
        (Array.isArray(current.turns) ? current.turns : [])
          .map((turn) => [String(turn?.turnId ?? ""), turn])
          .filter(([turnId]) => turnId),
      );
      for (const turnId of Array.isArray(delta?.removedTurnIds) ? delta.removedTurnIds : []) {
        turnsById.delete(String(turnId));
      }
      for (const turn of Array.isArray(delta?.updates) ? delta.updates : []) {
        const turnId = String(turn?.turnId ?? "");
        if (turnId) turnsById.set(turnId, turn);
      }
      const nextTokenUsage = {
        ...current,
        status: delta?.status ?? current.status,
        error: Object.prototype.hasOwnProperty.call(delta ?? {}, "error")
          ? delta.error
          : current.error,
        turns: [...turnsById.values()].sort((left, right) =>
          Number(left?.updatedAt) - Number(right?.updatedAt)),
      };
      state.tokenUsageRevision = revision;
      state.data = { ...state.data, tokenUsage: nextTokenUsage };
      ensureMounted();
      scheduleConversationTokenUsageRender();
    },
    drainActions() {
      return state.actions.splice(0);
    },
    destroy() {
      themeObserver.disconnect();
      themeQuery?.removeEventListener("change", syncTheme);
      hideAccountTooltip();
      state.observer?.disconnect();
      state.observer = null;
      state.mountObserver?.disconnect();
      state.mountObserver = null;
      if (state.mountCheckFrame != null) {
        window.cancelAnimationFrame(state.mountCheckFrame);
        state.mountCheckFrame = null;
      }
      clearConversationTooltipTimer();
      if (state.conversationRenderFrame != null) {
        window.cancelAnimationFrame(state.conversationRenderFrame);
        state.conversationRenderFrame = null;
      }
      window.removeEventListener("resize", state.resizeHandler);
      document.removeEventListener("pointerdown", state.documentPointerHandler, true);
      document.querySelectorAll("[data-codex-token-usage], [data-codex-token-usage-footer]")
        .forEach((node) => node.remove());
      state.conversationTooltip?.remove();
      state.conversationTooltipBridge?.remove();
      state.conversationTooltip = null;
      state.conversationTooltipBridge = null;
      state.conversationTooltipTimer = null;
      state.conversationTooltipPendingLine = null;
      state.conversationTooltipPendingPointer = null;
      state.conversationTooltipTarget = null;
      state.conversationTooltipPointer = null;
      state.conversationTurnNodes.clear();
      state.conversationUsageLines.clear();
      state.conversationObserverRoot = null;
      document.getElementById(GLOBAL_STYLE_ID)?.remove();
      state.root?.remove();
      delete window[GLOBAL_KEY];
    },
  };
  return VERSION;
}

export { installQuotaWidget };
