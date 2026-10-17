import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}`,
    );
  return result.stdout;
}
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("Lifeboat requires an Apple Silicon Mac.");
const running = spawnSync("/usr/bin/pgrep", ["-x", "flow-lifeboat"], {
  encoding: "utf8",
});
if (running.status === 0)
  throw new Error(
    "A Lifeboat operation is running. Let it finish before replacing the helper.",
  );
run(
  "/usr/bin/swift",
  ["build", "--package-path", "native/lifeboat", "--product", "flow-lifeboat"],
  { stdio: "inherit" },
);
const binDir = run("/usr/bin/swift", [
  "build",
  "--package-path",
  "native/lifeboat",
  "--show-bin-path",
]).trim();
const destination = join(homedir(), ".local/lib/jb-flow/flow-lifeboat");
const staged = `${destination}.new-${process.pid}`;
await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
try {
  await copyFile(join(binDir, "flow-lifeboat"), staged);
  await chmod(staged, 0o700);
  const identities = run("/usr/bin/security", [
    "find-identity",
    "-v",
    "-p",
    "codesigning",
  ]);
  const identity =
    process.env.LIFEBOAT_SIGN_IDENTITY ??
    /([A-F0-9]{40}) "Apple Development:/.exec(identities)?.[1] ??
    "-";
  run(
    "/usr/bin/codesign",
    [
      "--force",
      "--sign",
      identity,
      "--identifier",
      "app.bb.jb-flow.lifeboat",
      staged,
    ],
    { stdio: "inherit" },
  );
  run("/usr/bin/codesign", ["--verify", "--strict", staged]);
  await rename(staged, destination);
  console.log(`Lifeboat helper installed at ${destination}`);
  if (identity === "-")
    console.log(
      "Ad-hoc signature: macOS may ask for Keychain access again after a rebuild.",
    );
} finally {
  await rm(staged, { force: true });
}
