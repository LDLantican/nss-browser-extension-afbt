/* Hears its own tab's page commands, keeps the channel open, and never answers. */
chrome.tabs.getCurrent((tab) => {
  chrome.runtime.onMessage.addListener((message) => message?.type === "ASH_PAGE_COMMAND" && message.tab_id === tab?.id);
});
