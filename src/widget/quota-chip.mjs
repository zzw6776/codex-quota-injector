// Browser-serializable factory shared by the legacy footer and navigation rail.
function createQuotaChip({ escapeHtml, number, levelClass }) {
  function balanceText(credits, rail = false) {
    if (credits?.unlimited) return "无限";
    if (Number(credits?.usdAmount) > 0) {
      return rail ? `$${Number(credits.usdAmount)}`
        : credits.formattedUsd || `US$${Number(credits.usdAmount).toFixed(2)}`;
    }
    if (Number(credits?.creditQuantity) > 0) {
      return rail ? `${Number(credits.creditQuantity)}点`
        : `${credits.creditQuantity} 点`;
    }
    return "";
  }

  function renderQuotaChip(credits, windows, layout) {
    const rail = layout === "rail";
    // Both layouts use the same actual windows and their original order.
    // Missing periods and unavailable balances do not create placeholder rows.
    const quotas = windows.filter(Boolean);
    const items = quotas.map(quota => {
      const text = `${number(quota.remainingPercent)}${rail ? "" : "%"}`;
      return `<span class="quota-chip-item ${levelClass(quota.remainingPercent)}">${text}</span>`;
    });
    const fullBalance = balanceText(credits);
    if (fullBalance) {
      const text = balanceText(credits, rail);
      const charsAttr = rail && text.length > 4 ? ` data-chars="${text.length}"` : "";
      items.push(`<span class="quota-chip-item quota-chip-balance"${charsAttr}>${escapeHtml(text)}</span>`);
    }
    if (!items.length) items.push('<span class="quota-chip-item">--</span>');
    return {
      html: items.join(rail ? "" : '<span class="quota-divider">·</span>'),
    };
  }

  return { renderQuotaChip };
}

export { createQuotaChip };
