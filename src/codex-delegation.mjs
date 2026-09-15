// Codex represents delegated user input as an unpaired tool output. Keep
// recognition shared by provider conversion and desktop evidence validation.
export function readCodexDelegationInput(item) {
  if (!item || !["function_call_output", "functionCallOutput"].includes(item.type) ||
    item.namespace !== "codex_app" ||
    !["create_thread", "send_message_to_thread"].includes(item.name) ||
    (typeof item.call_id === "string" && item.call_id.trim())) return null;
  if (item.output?.truncated === true) return null;
  const output = typeof item.output === "string" ? item.output : item.output?.text;
  if (typeof output !== "string") return null;
  const match = /^\s*<codex_delegation>\s*<source_thread_id>([^<>\s]+)<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/.exec(output);
  return match?.[2].trim() ? match[2] : null;
}
