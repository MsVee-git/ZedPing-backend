// One bounded batch at a time. Database claims arbitrate across replicas.
function startGupshupWorkerLoop({ run, enabled = false, intervalMs = 2000, onError = () => {}, schedule = setTimeout, cancel = clearTimeout }) {
 if (!enabled) return () => {}
 let stopped = false, timer
 async function tick() {
  try { await run() } catch { onError('Gupshup worker batch failed') }
  if (!stopped) timer = schedule(tick, intervalMs)
 }
 timer = schedule(tick, 0)
 return () => { stopped = true; cancel(timer) }
}
module.exports = { startGupshupWorkerLoop }
