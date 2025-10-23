(() => {
  const content = {
    save_button_class: "nss-save-work-order",
    remove_button_class: "nss-remove-work-order",
    work_orders: new Map(),

    init: async function () {
      // chrome.storage.local.clear();

      const workOrderList = await this.queryElement(
        ".js-work-order-list ul.list-group"
      );
      if (!workOrderList) return;

      const workOrderItems = workOrderList.querySelectorAll(
        ":scope > li.list-group-item"
      );
      if (!workOrderItems) return;

      chrome.storage.local.get("work_orders", (result) => {
        const data = result.work_orders || {};
        if (typeof data !== "object") throw new Error("Invalid map data.");

        this.work_orders = new Map(Object.entries(data));

        workOrderItems.forEach((workOrderItem) => {
          // check if already exist in work_orders storage
          const workOrderNumber =
            workOrderItem.querySelector(
              ".js-work-order-number [aria-label='Number']"
            ).textContent || null;
          if (!workOrderNumber) return;

          if (this.work_orders.has(workOrderNumber)) {
            this.insertRemoveButton(workOrderItem);
          } else {
            this.insertSaveButton(workOrderItem);
          }
        });
      });
    },

    queryElement: function (selector) {
      if (typeof selector !== "string") throw new Error("Invalid selector.");

      let element = document.querySelector(selector);
      if (element) return Promise.resolve(element);

      return new Promise((resolve) => {
        const observer = new MutationObserver((mutationsList, obs) => {
          element = document.querySelector(selector);

          if (element) {
            obs.disconnect();
            resolve(element);
          }
        });

        observer.observe(document.body, { childList: true, subtree: true });
      });
    },

    insertSaveButton: function (listItem) {
      if (!(listItem instanceof Element)) throw new Error("Invalid element.");

      const buttonClassName = this.save_button_class;
      if (listItem.querySelector("." + buttonClassName)) return;

      const saveButton = document.createElement("button");
      saveButton.className = buttonClassName + " nss-button";
      saveButton.title = "Grab";

      const iconSave = document.createElement("i");
      iconSave.className = "icon";

      const svgSave = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640">
          <path d="M160 96C124.7 96 96 124.7 96 160L96 480C96 515.3 124.7 544 160 544L480 544C515.3 544 544 515.3 544 480L544 160C544 124.7 515.3 96 480 96L160 96zM296 408L296 344L232 344C218.7 344 208 333.3 208 320C208 306.7 218.7 296 232 296L296 296L296 232C296 218.7 306.7 208 320 208C333.3 208 344 218.7 344 232L344 296L408 296C421.3 296 432 306.7 432 320C432 333.3 421.3 344 408 344L344 344L344 408C344 421.3 333.3 432 320 432C306.7 432 296 421.3 296 408z"/>
        </svg>
      `;
      iconSave.innerHTML = svgSave;

      const spanSave = document.createElement("span");
      spanSave.className = "sr-only";
      spanSave.textContent = "Save Work Order";

      saveButton.addEventListener("click", () => {
        this.saveWorkOrder(listItem);
      });

      saveButton.appendChild(iconSave);
      saveButton.appendChild(spanSave);
      listItem.appendChild(saveButton);
    },

    insertRemoveButton: function (listItem) {
      if (!(listItem instanceof Element)) throw new Error("Invalid element.");

      const buttonClassName = this.remove_button_class;
      if (listItem.querySelector("." + buttonClassName)) return;

      const removeButton = document.createElement("button");
      removeButton.className = buttonClassName + " nss-button";
      removeButton.title = "Remove";

      const iconRemove = document.createElement("i");
      iconRemove.className = "icon";

      const svgRemove = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640">
          <path d="M160 96C124.7 96 96 124.7 96 160L96 480C96 515.3 124.7 544 160 544L480 544C515.3 544 544 515.3 544 480L544 160C544 124.7 515.3 96 480 96L160 96zM232 296L408 296C421.3 296 432 306.7 432 320C432 333.3 421.3 344 408 344L232 344C218.7 344 208 333.3 208 320C208 306.7 218.7 296 232 296z"/>
        </svg>
      `;
      iconRemove.innerHTML = svgRemove;

      const spanRemove = document.createElement("span");
      spanRemove.className = "sr-only";
      spanRemove.textContent = "Remove Work Order";

      removeButton.addEventListener("click", () => {
        this.removeWorkOrder(listItem);
      });

      removeButton.appendChild(iconRemove);
      removeButton.appendChild(spanRemove);
      listItem.appendChild(removeButton);
    },

    saveWorkOrder: async function (listItem) {
      if (!(listItem instanceof Element)) throw new Error("Invalid list item.");

      const workOrderNumber =
        listItem.querySelector(".js-work-order-number [aria-label='Number']")
          .textContent || null;
      if (!workOrderNumber) return;

      const expandButton = listItem.querySelector(
        "button.js-expand.btn.btn-link:has(i.fa-chevron-down,i.fa-chevron-up)"
      );
      if (!expandButton) {
        console.error("Can't fetch work order data.", workOrderNumber);
        return;
      }

      expandButton.click();

      const street =
        listItem.querySelector("[aria-label='Address']").textContent || "";
      const cityStateZip =
        listItem.querySelector("[aria-label='AddressCityAndState']")
          .textContent || "";

      const description =
        listItem.querySelector("[aria-label='Description']").textContent || "";

      const regex = /(.+?), ([A-Z]{2}) (\d{5}(?:-\d{4})?)/;
      const match = cityStateZip.match(regex);

      let city = "";
      let state = "";
      let zip = "";

      if (match) {
        city = (match[1] || "").trim();
        state = match[2] || "";
        zip = match[3] || "";
      }

      expandButton.click();

      const work_order = {
        number: workOrderNumber || "",
        street: street || "",
        city: city || "",
        state: state || "",
        zip: zip || "",
        description: description || "",
      };

      chrome.storage.local.get("work_orders", (result) => {
        const data = result.work_orders || {};
        if (typeof data !== "object") throw new Error("Invalid map data.");

        this.work_orders = new Map(Object.entries(data));

        this.work_orders.set(work_order.number, work_order);

        chrome.storage.local.set(
          { work_orders: Object.fromEntries(this.work_orders) },
          () => {}
        );
      });
    },

    removeWorkOrder: async function (listItem) {
      if (!(listItem instanceof Element)) throw new Error("Invalid list item.");

      const workOrderNumber =
        listItem.querySelector(".js-work-order-number [aria-label='Number']")
          .textContent || null;
      if (!workOrderNumber) return;

      chrome.storage.local.get("work_orders", (result) => {
        const data = result.work_orders || {};
        if (typeof data !== "object") throw new Error("Invalid map data.");

        this.work_orders = new Map(Object.entries(data));

        if (!this.work_orders.has(workOrderNumber)) return;

        this.work_orders.delete(workOrderNumber);

        chrome.storage.local.set(
          { work_orders: Object.fromEntries(this.work_orders) },
          () => {}
        );
      });
    },

    observeUrlChange: function () {
      let lastUrl = location.href;

      new MutationObserver(() => {
        const currentUrl = location.href;

        if (
          currentUrl !== lastUrl &&
          location.pathname.includes(
            "/maintenance/service_requests/work_orders"
          )
        ) {
          lastUrl = currentUrl;
          content.init();
        }
      }).observe(document.body, { childList: true, subtree: true });
    },
  };

  content.init();
  content.observeUrlChange();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" && !changes.work_orders) return;

    const allButtons = document.querySelectorAll(".nss-button");
    if (!allButtons) return;

    allButtons.forEach((button) => button.remove());
    content.init();
  });
})();
