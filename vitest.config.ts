import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "jsdom",
    include: [
      "studio.ui.test.tsx",
      "shell-appearance.ui.test.tsx",
      "live-activity.ui.test.tsx",
    ],
  },
});
