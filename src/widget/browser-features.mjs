import { createFormatting } from "./formatting.mjs";
import { createBalance } from "./balance.mjs";
import { createHostHealth } from "./host-health.mjs";
import { createPanel } from "./panel.mjs";
import { createUsageDetails } from "./usage-details.mjs";
import { createContext } from "./context.mjs";
import { createMigration } from "./migration.mjs";
import { createWakeup } from "./wakeup.mjs";
import { createAccounts } from "./accounts.mjs";
import { createTooltipPosition } from "./tooltip-position.mjs";
import { createConversationUsage } from "./conversation-usage.mjs";
import { createUsageTooltip } from "./usage-tooltip.mjs";
import { createModelsPage } from "./models-page.mjs";
import { createModelEditor } from "./model-editor.mjs";

// Factories carry no module closure into the injected browser expression.
const WIDGET_FEATURES = {
  formatting: createFormatting,
  balance: createBalance,
  host_health: createHostHealth,
  panel: createPanel,
  usage_details: createUsageDetails,
  context: createContext,
  migration: createMigration,
  wakeup: createWakeup,
  accounts: createAccounts,
  tooltip_position: createTooltipPosition,
  conversation_usage: createConversationUsage,
  usage_tooltip: createUsageTooltip,
  models_page: createModelsPage,
  model_editor: createModelEditor,
};

export { WIDGET_FEATURES };
