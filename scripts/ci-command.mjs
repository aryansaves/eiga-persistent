import { spawn } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("A verification command is required.");
const child = spawn(command, args, {
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
});
let tail = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    process.stdout.write(chunk);
    tail = (tail + chunk.toString()).slice(-7000);
  });
}
child.on("error", () => {
  console.error("::error::Could not start the verification command.");
  process.exitCode = 1;
});
child.on("close", (code) => {
  if (code === 0) return;
  // Annotations make failure diagnostics available through check runs without
  // requiring a personal GitHub token to download the complete Actions log.
  let message = `${command} failed (${code ?? "signal"}).\n${tail}`;
  for (const name of [
    "CLOUDFLARE_API_TOKEN",
    "EIGA_DEPLOY_DISPATCH_TOKEN",
    "GOOGLE_CLIENT_SECRET",
  ]) {
    const secret = process.env[name];
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  console.error(
    `::error::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`,
  );
  process.exitCode = code || 1;
});
