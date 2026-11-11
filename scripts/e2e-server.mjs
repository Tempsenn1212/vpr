import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
const dir = mkdtempSync(join(tmpdir(), "vpr-e2e-"));
const { app, db } = createApp({
  database: join(dir, "e2e.sqlite"),
  production: false,
  demo: true,
  botToken: "synthetic-e2e-bot-token",
  origin: "http://localhost:4173",
});
const server = app.listen(4173, "0.0.0.0");
for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, () =>
    server.close(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
      process.exit(0);
    }),
  );
