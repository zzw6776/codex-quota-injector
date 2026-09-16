import { createBalance } from "./balance.mjs";
import { createHostHealth } from "./host-health.mjs";
import { createUsageLines } from "./usage-lines.mjs";
import { createUsageTooltip } from "./usage-tooltip.mjs";
import { createTooltipPosition } from "./tooltip-position.mjs";
import { createUsageDetails } from "./usage-details.mjs";
import { createFormatting } from "./formatting.mjs";
import { createContext } from "./context.mjs";
import { createModelViews } from "./model-views.mjs";
import { createModelState } from "./model-state.mjs";
import { createModelForms } from "./model-forms.mjs";
import { createPanelLayout } from "./panel-layout.mjs";
import { createMigration } from "./migration.mjs";
import { createWakeup } from "./wakeup.mjs";
import { createAccounts } from "./accounts.mjs";
import { createAccountTooltip } from "./account-tooltip.mjs";
import { createPanelEvents } from "./panel-events.mjs";
import { createNavigationEvents } from "./navigation-events.mjs";
import { createModelEvents } from "./model-events.mjs";
import { createConversationObserver } from "./conversation-observer.mjs";

const WIDGET_FEATURES = {
  balance: createBalance,
  host_health: createHostHealth,
  usage_lines: createUsageLines,
  usage_tooltip: createUsageTooltip,
  tooltip_position: createTooltipPosition,
  usage_details: createUsageDetails,
  formatting: createFormatting,
  context: createContext,
  model_views: createModelViews,
  model_state: createModelState,
  model_forms: createModelForms,
  panel_layout: createPanelLayout,
  migration: createMigration,
  wakeup: createWakeup,
  accounts: createAccounts,
  account_tooltip: createAccountTooltip,
  panel_events: createPanelEvents,
  navigation_events: createNavigationEvents,
  model_events: createModelEvents,
  conversation_observer: createConversationObserver,
};

export { WIDGET_FEATURES };
