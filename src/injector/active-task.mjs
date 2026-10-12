// Official sidebar attributes identify the displayed task, unlike the most recent
// thread/resume event (which can belong to a background task).
export function readVisibleHostTask() {
  const rows = [...document.querySelectorAll('[data-app-action-sidebar-thread-active="true"]')];
  const tasks = rows.map(row => {
    const hostId = row.getAttribute("data-app-action-sidebar-thread-host-id");
    const key = row.getAttribute("data-app-action-sidebar-thread-id");
    const kind = row.getAttribute("data-app-action-sidebar-thread-kind");
    if (!hostId || !key?.startsWith(`${hostId}:`) || kind !== "local") return null;
    return { hostId, threadId: key.slice(hostId.length + 1) };
  }).filter(Boolean);
  const unique = [...new Map(tasks.map(task => [`${task.hostId}:${task.threadId}`, task])).values()];
  if (unique.length !== 1) return null;
  const selected = unique[0];
  if (!selected.threadId.startsWith("client-new-thread:")) return selected;

  // Newer desktop builds can retain the provisional sidebar key after the
  // conversation has a real thread ID. The active thread composer carries
  // that ID. Inactive conversations remain mounted, so inspect visibility on
  // the composer root (the ID portal itself may be empty and display:none).
  const composers = [...document.querySelectorAll(
    '[data-codex-composer-root][data-composer-placement="thread"]',
  )].filter(composer => composer.checkVisibility({ checkVisibilityCSS: true }));
  if (composers.length !== 1) return null;
  const threadIds = [...new Set([...composers[0].querySelectorAll('[data-above-composer-conversation-id]')]
    .map(node => node.getAttribute("data-above-composer-conversation-id")))];
  if (threadIds.length !== 1) return null;
  const threadId = threadIds[0];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId ?? "")) return null;
  return { hostId: selected.hostId, threadId };
}
