(() => {
  const authLocalStorageKey = "bt-object-previousAuthStoreInfo";

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "GET_BT_AUTH") {
      const authData = localStorage.getItem(authLocalStorageKey);
      sendResponse({ authData });
    }

    return true;
  });

  window.addEventListener("storage", (event) => {
    if (event.key === authLocalStorageKey) {
      chrome.runtime.sendMessage({
        type: "BT_AUTH_CHANGED",
        data: event.newValue,
      });
    }
  });
})();
