/**
 * The pretend AppFolio, slowed as a hidden tab is: with `?slow_timers=<ms>` in
 * its address, every setTimeout on the page fires that much later. Loaded
 * before page.js, so page.js's own timers are slowed exactly as they were in
 * the worker's background tab on 2026-11-24, when AppFolio's inspection page
 * went unanswered for 30 s while Chrome called the tab active.
 *
 * The pretend server (network.js) keeps the real setTimeout, which this leaves
 * on `ash_native_set_timeout`: a hidden tab slows the page, not AppFolio's
 * servers.
 */

(() => {
  const native = window.setTimeout;
  const slow = Math.max(0, Number(new URLSearchParams(location.search).get("slow_timers") || 0));

  window.ash_native_set_timeout = native.bind(window);

  if (slow === 0) return;

  window.setTimeout = function (handler, ms, ...rest) {
    return native.call(window, handler, Number(ms || 0) + slow, ...rest);
  };
})();
