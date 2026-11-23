/**
 * The pretend AppFolio's server. The site sends every write here, as the live
 * inspection page sends its saves to /inspections/graphql, and it is answered
 * after `?delay=` milliseconds with nothing leaving the page.
 *
 * It exists so page_bridge.js, loaded after it, has real requests in flight to
 * count, and so a slow save can be imitated (`slow_switch_ms` in the books):
 * page.js 1.0.7 waits for the page's writes to be answered before it goes on,
 * and on the pretend site that is only testable if there are writes to wait for.
 */

(() => {
  const native = window.fetch;
  const PATH = "/__pretend_save";

  window.fetch = function (input, init) {
    const url = new URL(String(input instanceof Request ? input.url : input), location.href);

    if (url.origin !== location.origin || url.pathname !== PATH) return native.apply(this, arguments);

    const delay = Math.max(0, Number(url.searchParams.get("delay") || 0));

    return new Promise((resolve) => setTimeout(() => resolve(new Response("{}", { status: 200 })), delay));
  };
})();
