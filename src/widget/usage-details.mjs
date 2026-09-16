// Browser-serializable factory: all external values arrive through this explicit boundary.
function createUsageDetails({ paginateDetails, detailTitle, phaseText, primaryText, networkLatencyText, averageNetworkLatency, toolRows, toolRowElement, executionRemainder, scrollbarEndPadding, formatGenerationRate, formatFirstTokenLatency, formatMetricDuration }) {
  function appendGenerationDetails(container, usage) {
    const details = Array.isArray(usage?.generationDetails) ? usage.generationDetails : [];
    const averageParts = [];
    if (Number(usage?.firstTokenLatencyMs) > 0) {
      averageParts.push(`平均首字 ${formatFirstTokenLatency(usage.firstTokenLatencyMs)}`);
    }
    if (Number(usage?.outputSpeed) > 0) {
      averageParts.push(`平均速率 ${formatGenerationRate(usage.outputSpeed)}`);
    }
    const averageLatencyMs = averageNetworkLatency(details);
    if (details.length > 0) {
      averageParts.push(`平均延时 ${averageLatencyMs == null
        ? "—"
        : formatMetricDuration(averageLatencyMs)}`);
    }
    const averageText = averageParts.join(" · ");
    if (details.length === 0) {
      const unavailable = document.createElement("div");
      unavailable.style.cssText = "margin-top:2px;padding-top:5px;border-top:1px solid rgba(127,127,127,.14);color:var(--color-token-text-tertiary,#9a9aa4);font-size:10px";
      unavailable.textContent = `请求明细不可用${averageText ? ` · ${averageText}` : ""}`;
      container.append(unavailable);
      return;
    }

    const detailSection = document.createElement("details");
    detailSection.style.cssText = "margin-top:2px;padding-top:5px;border-top:1px solid rgba(127,127,127,.14)";
    const summary = document.createElement("summary");
    summary.textContent = `请求明细 ${details.length} 次${averageText ? ` · ${averageText}` : ""}`;
    summary.style.cssText = "cursor:pointer;color:var(--color-token-text-tertiary,#9a9aa4);font-size:10px;user-select:none";
    const list = document.createElement("div");
    list.setAttribute("data-codex-scrollbar-container", "");
    list.style.cssText = "display:grid;gap:5px;max-height:240px;overflow-x:hidden;overflow-y:auto;scrollbar-gutter:stable;margin-top:5px;box-sizing:border-box";
    let visibleCount = 20;

    const renderDetails = () => {
      const page = paginateDetails(details, visibleCount);
      list.replaceChildren();
      for (const [index, detail] of page.items.entries()) {
        const title = detailTitle(
          detail,
          index === 0 && Boolean(usage?.completed),
        );
        const primaryMetrics = primaryText(detail, networkLatencyText);
        const diagnostics = phaseText(detail);

        const header = document.createElement("div");
        header.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);align-items:baseline;gap:12px;font-size:10px";
        const name = document.createElement("span");
        name.style.cssText = "min-width:0;color:var(--color-token-text-tertiary,#9a9aa4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
        name.textContent = title;
        const metrics = document.createElement("span");
        metrics.style.cssText = "text-align:right;font-variant-numeric:tabular-nums";
        metrics.textContent = primaryMetrics;
        header.append(name, metrics);

        const calls = toolRows(detail);
        if (diagnostics || calls.length > 0) {
          const request = document.createElement("details");
          const requestSummary = document.createElement("summary");
          requestSummary.style.cssText = "cursor:pointer;user-select:none;list-style-position:outside";
          requestSummary.append(header);
          const expanded = document.createElement("div");
          expanded.setAttribute("data-codex-scrollbar-container", "");
          expanded.style.cssText = "display:grid;gap:4px;max-height:180px;overflow-x:hidden;overflow-y:auto;scrollbar-gutter:stable;margin:4px 0 1px 13px;padding:4px 0 4px 5px;box-sizing:border-box;border-left:1px solid rgba(127,127,127,.18)";
          if (diagnostics) {
            const phaseRow = document.createElement("div");
            phaseRow.style.cssText = "display:flex;flex-wrap:wrap;gap:2px 10px;min-width:0;color:var(--color-token-text-tertiary,#9a9aa4);font-size:9px;font-variant-numeric:tabular-nums";
            for (const stage of diagnostics.split(" · ")) {
              if (!stage) continue;
              const segment = document.createElement("span");
              segment.style.cssText = "max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
              segment.textContent = stage;
              segment.title = stage;
              phaseRow.append(segment);
            }
            expanded.append(phaseRow);
          }
          for (const call of calls) {
            expanded.append(toolRowElement(document, call, formatMetricDuration));
          }
          const remainingDuration = executionRemainder(detail);
          if (remainingDuration != null) {
            expanded.append(toolRowElement(document, {
              toolName: "其余调用耗时", durationMs: remainingDuration, approximate: true,
            }, formatMetricDuration));
          }
          request.append(requestSummary, expanded);
          request.addEventListener("toggle", () => {
            if (request.open) syncConversationScrollbarPadding(request);
          });
          list.append(request);
        } else {
          list.append(header);
        }
      }
      if (page.remaining > 0) {
        const more = document.createElement("button");
        more.type = "button";
        more.style.cssText = "border:0;padding:2px 0;background:transparent;color:var(--color-token-text-tertiary,#9a9aa4);font:inherit;text-align:left;cursor:pointer";
        more.textContent = `显示更早 ${Math.min(20, page.remaining)} 次`;
        more.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          visibleCount += 20;
          renderDetails();
        });
        list.append(more);
      }
    };

    renderDetails();
    detailSection.append(summary, list);
    detailSection.addEventListener("toggle", () => {
      if (detailSection.open) syncConversationScrollbarPadding(detailSection);
    });
    container.append(detailSection);
  }

  function syncConversationScrollbarPadding(root) {
    for (const container of root.querySelectorAll("[data-codex-scrollbar-container]")) {
      if (container.offsetWidth <= 0) continue;
      const style = getComputedStyle(container);
      const borderWidth = (Number.parseFloat(style.borderLeftWidth) || 0) +
        (Number.parseFloat(style.borderRightWidth) || 0);
      container.style.paddingRight = `${scrollbarEndPadding(
        container.offsetWidth,
        container.clientWidth,
        borderWidth,
      )}px`;
    }
  }

  return { appendGenerationDetails, syncConversationScrollbarPadding };
}

export { createUsageDetails };
