import { positiveNumber, nonEmptyString } from "./contract.mjs";

function findTurnAtTimestamp(turns, timestamp) {
  const enclosing = turns.find((turn) => {
    const turnStartedAt = positiveNumber(turn.startedAt) || positiveNumber(turn.updatedAt);
    return turnStartedAt <= timestamp &&
      (!turn.completed || positiveNumber(turn.updatedAt) >= timestamp);
  });
  return enclosing ??
    turns.find((turn) =>
      (positiveNumber(turn.startedAt) || positiveNumber(turn.updatedAt)) <= timestamp) ??
    turns[0] ?? null;
}

function applySubagentMetadata({ rolloutMetadataByThread, turns, loggedSubagentModelTransitions }) {
    let changed = false;
    const metadataItems = [...rolloutMetadataByThread.values()]
      .filter((metadata) => metadata.isSubagent)
      .sort((left, right) => left.agentDepth - right.agentDepth);
    for (const metadata of metadataItems) {
      const agentTurns = [...turns.values()]
        .filter((turn) => turn.threadId === metadata.threadId)
        .sort((left, right) =>
          positiveNumber(left.startedAt) - positiveNumber(right.startedAt) ||
          positiveNumber(left.updatedAt) - positiveNumber(right.updatedAt));
      if (agentTurns.length === 0) continue;
      for (let index = 1; index < agentTurns.length; index += 1) {
        const previousTurn = agentTurns[index - 1];
        const turn = agentTurns[index];
        const previousModel = nonEmptyString(previousTurn.model);
        const model = nonEmptyString(turn.model);
        if (!previousModel || !model || previousModel === model) continue;
        const transitionKey = `${metadata.threadId}\u0000${previousTurn.turnId}\u0000${turn.turnId}`;
        if (loggedSubagentModelTransitions.has(transitionKey)) continue;
        loggedSubagentModelTransitions.add(transitionKey);
        console.warn(
          `[token-usage] 子智能体模型发生变化：thread=${metadata.threadId}，` +
          `previousTurn=${previousTurn.turnId}，previousModel=${previousModel}，` +
          `turn=${turn.turnId}，model=${model}`,
        );
      }
      for (const turn of agentTurns) {
        const previousParentTurnId = nonEmptyString(turn.parentTurnId);
        const parentTurnId = resolveSubagentParentTurnId(metadata, turn, { rolloutMetadataByThread, turns });
        const nextValues = {
          taskKey: metadata.threadId,
          isSubagent: true,
          rootThreadId: metadata.rootThreadId,
          parentThreadId: metadata.parentThreadId,
          parentTurnId: parentTurnId ?? "",
          agentPath: metadata.agentPath,
          agentNickname: metadata.agentNickname,
          agentDepth: metadata.agentDepth,
        };
        for (const [key, value] of Object.entries(nextValues)) {
          if (turn[key] === value) continue;
          turn[key] = value;
          changed = true;
        }
        if (parentTurnId && previousParentTurnId !== parentTurnId) {
          console.log(
            `[token-usage] 子智能体 turn 归属${previousParentTurnId ? "已修正" : "已确认"}：` +
            `thread=${metadata.threadId}，turn=${turn.turnId}，` +
            `parentTurn=${parentTurnId}，model=${nonEmptyString(turn.model) ?? "unknown"}` +
            `${previousParentTurnId ? `，previousParentTurn=${previousParentTurnId}` : ""}`,
          );
        }
      }
    }
    return changed;
  }

function resolveSubagentParentTurnId(metadata, agentTurn, { rolloutMetadataByThread, turns }) {
    const startedAt = positiveNumber(agentTurn.startedAt) || positiveNumber(agentTurn.updatedAt);
    const parentMetadata = rolloutMetadataByThread.get(metadata.parentThreadId);
    if (parentMetadata?.isSubagent) {
      const parentAgentTurns = [...turns.values()]
        .filter((turn) => turn.threadId === parentMetadata.threadId)
        .sort((left, right) =>
          (positiveNumber(right.startedAt) || positiveNumber(right.updatedAt)) -
          (positiveNumber(left.startedAt) || positiveNumber(left.updatedAt)));
      const parentAgentTurn = findTurnAtTimestamp(parentAgentTurns, startedAt);
      const inheritedParentTurnId = nonEmptyString(parentAgentTurn?.parentTurnId);
      if (inheritedParentTurnId) return inheritedParentTurnId;
    }
    const rootTurns = [...turns.values()]
      .filter((turn) => turn.threadId === metadata.rootThreadId && !turn.isSubagent)
      .sort((left, right) =>
        (positiveNumber(right.startedAt) || positiveNumber(right.updatedAt)) -
        (positiveNumber(left.startedAt) || positiveNumber(left.updatedAt)));
    return findTurnAtTimestamp(rootTurns, startedAt)?.turnId ?? null;
  }

export { applySubagentMetadata };
