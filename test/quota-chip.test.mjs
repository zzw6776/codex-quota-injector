import assert from "node:assert/strict";
import test from "node:test";
import { createQuotaChip } from "../src/widget/quota-chip.mjs";

test("rail 布局下长余额自动生成 data-chars 属性以便样式自适应缩放字体", () => {
  const { renderQuotaChip } = createQuotaChip({
    escapeHtml: (s) => String(s),
    number: (n) => String(n),
    levelClass: () => "level-normal",
  });

  // 较短余额（如 $5）在 rail 模式下无需缩放
  const shortChip = renderQuotaChip({ usdAmount: 5 }, [{ remainingPercent: 94 }], "rail");
  assert.ok(shortChip.html.includes("quota-chip-balance"));
  assert.ok(!shortChip.html.includes("data-chars"));

  // 较长余额（如 $2499.44）在 rail 模式下生成 data-chars="8"
  const longChip = renderQuotaChip({ usdAmount: 2499.44 }, [{ remainingPercent: 94 }], "rail");
  assert.ok(longChip.html.includes('quota-chip-balance" data-chars="8"'));
  assert.ok(longChip.html.includes("$2499.44"));

  // 宽幅 footer 布局下不需要 data-chars
  const footerChip = renderQuotaChip({ usdAmount: 2499.44 }, [{ remainingPercent: 94 }], "footer");
  assert.ok(!footerChip.html.includes("data-chars"));
});
