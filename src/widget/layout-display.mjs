function calculatePopoverMaxHeight(chipTop) {
  const TITLE_BAR_SAFE_TOP = 44;
  const ANCHOR_GAP = 10;
  const MAX_HEIGHT = 720;
  const top = Number(chipTop);
  if (!Number.isFinite(top)) return 0;
  return Math.max(0, Math.min(MAX_HEIGHT, Math.floor(top - TITLE_BAR_SAFE_TOP - ANCHOR_GAP)));
}

function calculateScrollbarEndPadding(
  offsetWidth,
  clientWidth,
  borderWidth = 0,
  targetClearance = 16,
) {
  const outer = Number(offsetWidth);
  const inner = Number(clientWidth);
  const borders = Math.max(0, Number(borderWidth) || 0);
  const fallback = Math.max(0, Number(targetClearance) || 0);
  if (!Number.isFinite(outer) || !Number.isFinite(inner)) return fallback;
  const scrollbarWidth = Math.max(0, outer - inner - borders);
  return Math.max(0, fallback - scrollbarWidth);
}

export { calculatePopoverMaxHeight, calculateScrollbarEndPadding };
