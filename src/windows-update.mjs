import {
  acquireSingleInstance,
  closeSingleInstance,
} from "./single-instance.mjs";
import { stopCodex } from "./platform.mjs";

export async function prepareWindowsUpdate({
  version,
  acquireSingleInstanceImpl = acquireSingleInstance,
  closeSingleInstanceImpl = closeSingleInstance,
  stopCodexImpl = stopCodex,
} = {}) {
  let instanceLock = null;
  try {
    instanceLock = await acquireSingleInstanceImpl({
      mode: "formal",
      version,
      explicitStart: true,
      purpose: "install-update",
    });
    if (!instanceLock) {
      throw new Error("现有注入器拒绝安装接管，无法安全覆盖运行中的文件");
    }
    await stopCodexImpl({ timeoutMs: 10_000 });
  } finally {
    await closeSingleInstanceImpl(instanceLock);
  }
}
