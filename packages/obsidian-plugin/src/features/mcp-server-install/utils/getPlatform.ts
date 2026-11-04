import os from "os";
import type { Platform } from "../constants";

export function getPlatform(): Platform {
  const platform = os.platform();
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}
