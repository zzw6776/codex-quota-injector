import { once } from "node:events";
import { createInterface } from "node:readline";

// This fixture only exchanges protocol messages. It never loads Codex or calls a model.
async function write(value) {
  if (!process.stdout.write(value)) await once(process.stdout, "drain");
}

await write(`${JSON.stringify({ method: "fixture/ready" })}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "fixture/emit") {
    const raw = message.params.raw ?? `${JSON.stringify(message.params.message)}\n`;
    const bytes = Buffer.from(raw);
    const size = message.params.chunkSize ?? bytes.length;
    for (let offset = 0; offset < bytes.length; offset += size) {
      await write(bytes.subarray(offset, offset + size));
    }
  } else {
    await write(`${JSON.stringify({ method: "fixture/received", params: { message, raw: line } })}\n`);
  }
}
