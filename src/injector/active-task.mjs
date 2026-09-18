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
  return unique.length === 1 ? unique[0] : null;
}
