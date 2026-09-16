import { WIDGET_RUNTIME_VERSION } from "./contract.mjs";
import { paginateGenerationDetails, formatGenerationDetailTitle, formatGenerationPhaseText, generationToolRows, generationExecutionRemainder, formatGenerationPrimaryText, averageGenerationNetworkLatency } from "./generation-display.mjs";
import { createGenerationToolRow } from "./generation-display.mjs";
import { selectConversationNetworkLatency, formatNetworkLatencyText, formatConversationUsageSummary } from "./usage-display.mjs";
import { calculatePopoverMaxHeight, calculateScrollbarEndPadding } from "./layout-display.mjs";
import { installQuotaWidget } from "./runtime.mjs";
import { WIDGET_FEATURES } from "./browser-features.mjs";
import { WIDGET_STYLES } from "./styles.mjs";

function widgetInstallExpression() {
  return `(${installQuotaWidget.toString()})(${calculatePopoverMaxHeight.toString()},${WIDGET_RUNTIME_VERSION},${paginateGenerationDetails.toString()},${formatGenerationDetailTitle.toString()},${formatGenerationPhaseText.toString()},${formatGenerationPrimaryText.toString()},${formatConversationUsageSummary.toString()},${selectConversationNetworkLatency.toString()},${formatNetworkLatencyText.toString()},${averageGenerationNetworkLatency.toString()},${generationToolRows.toString()},${createGenerationToolRow.toString()},${generationExecutionRemainder.toString()},${calculateScrollbarEndPadding.toString()},${serializeWidgetFeatures()},${JSON.stringify(WIDGET_STYLES)})`;
}

function widgetRuntimeVersionExpression() {
  return "window.__codexQuotaWidget?.version ?? null";
}

function widgetUpdateExpression(data) {
  return `window.__codexQuotaWidget?.update(${JSON.stringify(data)})`;
}

function widgetUpdateExpressionJson(serializedData, revision = null) {
  const revisionArgument = revision == null ? "" : `,${JSON.stringify(revision)}`;
  return `window.__codexQuotaWidget?.update(${String(serializedData)}${revisionArgument})`;
}

function widgetTokenUsageUpdateExpressionJson(serializedTokenUsage, revision = null) {
  const revisionArgument = revision == null ? "" : `,${JSON.stringify(revision)}`;
  return `window.__codexQuotaWidget?.updateTokenUsage(${String(serializedTokenUsage)}${revisionArgument})`;
}

function widgetExtraModelsUpdateExpressionJson(serializedExtraModels, revision = null) {
  const revisionArgument = revision == null ? "" : `,${JSON.stringify(revision)}`;
  return `window.__codexQuotaWidget?.updateExtraModels(${String(serializedExtraModels)}${revisionArgument})`;
}

function widgetNetworkUpdateExpressionJson(serializedNetwork) {
  return `window.__codexQuotaWidget?.updateNetwork(${String(serializedNetwork)})`;
}

function widgetTokenUsageDeltaUpdateExpressionJson(serializedDelta, revision = null) {
  const revisionArgument = revision == null ? "" : `,${JSON.stringify(revision)}`;
  return `window.__codexQuotaWidget?.updateTokenUsageDelta(${String(serializedDelta)}${revisionArgument})`;
}

function widgetDrainActionsExpression() {
  return "window.__codexQuotaWidget?.drainActions?.() ?? []";
}

function serializeWidgetFeatures() {
  return `{${Object.entries(WIDGET_FEATURES).map(([name, factory]) => `${JSON.stringify(name)}:(${factory.toString()})`).join(",")}}`;
}

export { widgetInstallExpression, widgetRuntimeVersionExpression, widgetUpdateExpression, widgetUpdateExpressionJson, widgetTokenUsageUpdateExpressionJson, widgetExtraModelsUpdateExpressionJson, widgetNetworkUpdateExpressionJson, widgetTokenUsageDeltaUpdateExpressionJson, widgetDrainActionsExpression };
