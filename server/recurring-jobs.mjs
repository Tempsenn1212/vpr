export function startRecurringJobs(
  store,
  {
    intervalMs = 60_000,
    onError = (error) =>
      console.error("Не удалось обновить автоматический учёт:", error.name),
  } = {},
) {
  const timer = setInterval(() => {
    try {
      store.syncRecurring();
    } catch (error) {
      onError(error);
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
