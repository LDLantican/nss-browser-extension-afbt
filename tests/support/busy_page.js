/* Hears its own tab's page command, then holds the main thread for 6 s and never answers. */
chrome.tabs.getCurrent((tab) => {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "ASH_PAGE_COMMAND" || message.tab_id !== tab?.id) return false;

    const until = Date.now() + 6000;

    while (Date.now() < until) {
      /* Busy: no task on this page runs until this ends. */
    }

    return false;
  });
});
