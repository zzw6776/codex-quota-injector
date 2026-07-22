import { createServer } from "node:net";

const SINGLE_INSTANCE_PORT = 49_229;

export async function acquireSingleInstance() {
  const server = createServer();
  server.unref();
  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        resolve(null);
      } else {
        reject(error);
      }
    });
    server.listen(SINGLE_INSTANCE_PORT, "127.0.0.1", () => resolve(server));
  });
}
