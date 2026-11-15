import { createApp } from "./app.mjs";
import { startRecurringJobs } from "./recurring-jobs.mjs";
const { app, db, store, config } = createApp();
const stopJobs = config.automation ? startRecurringJobs(store) : () => {};
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, "0.0.0.0", () =>
  console.log(`ВПР: http://localhost:${port}`),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () =>
    server.close(() => {
      stopJobs();
      db.close();
      process.exit(0);
    }),
  );
