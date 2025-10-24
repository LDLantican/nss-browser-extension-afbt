(() => {
  const content = {
    save_button_class: "nss-save-work-order",
    remove_button_class: "nss-remove-work-order",
    work_order: {
      number: "",
      street: "",
      city: "",
      state: "",
      zip: "",
      description: "",
    },
    work_orders: new Map(),

    init: async function () {
      // get work order number
      const workOrderDetails = await this.queryElement(
        ".js-work-order-body__details"
      );
      if (!workOrderDetails) return;

      const workOrderHeaderText =
        workOrderDetails.querySelector(
          ".js-work-order-header-left.work-order-header__left"
        ).textContent || "";

      const workOrderNumberRegex = /\d+-\d+/;
      const workOrderNumberMatch =
        workOrderHeaderText.match(workOrderNumberRegex);
      const workOrderNumber = workOrderNumberMatch
        ? workOrderNumberMatch[0]
        : null;
      if (!workOrderNumber) return;

      this.work_order.number = workOrderNumber;

      // get description
      const description =
        workOrderDetails.querySelector(".js-work-order-description.u-space-bl")
          .textContent || "";

      this.work_order.description = description;

      // get full address and parts
      const propertyContactContainer = await this.queryElement(
        ".contact-card-container"
      );
      if (!propertyContactContainer) return;

      const addressElement = propertyContactContainer.querySelector(
        ".js-contact-card-address"
      );
      const fullAddress = addressElement.innerHTML.replace(
        /<br\s*\/?>/gi,
        " | "
      );

      const addressRegex = /^(.+?)\s*\|\s*(.+?),\s*([A-Z]{2})\s*(\d{5})$/;
      const addressMatch = fullAddress.match(addressRegex);

      if (addressMatch) {
        this.work_order.street = addressMatch[1] || "";
        this.work_order.city = addressMatch[2] || "";
        this.work_order.state = addressMatch[3] || "";
        this.work_order.zip = addressMatch[4] || "";
      }

      const serviceRequestHeader = await this.queryElement(
        "div.u-clearfix:has(h2.service-request__box-title.js-service-request-title)"
      );
      if (!serviceRequestHeader) return;

      // check if work order number exist in storage
      chrome.storage.local.get("work_orders", (result) => {
        const data = result.work_orders || {};
        if (typeof data !== "object") throw new Error("Invalid map data.");

        this.work_orders = new Map(Object.entries(data));

        // add save/remove button
        if (this.work_orders.has(this.work_order.number)) {
          this.insertRemoveButton(serviceRequestHeader);
        } else {
          this.insertSaveButton(serviceRequestHeader);
        }
      });
    },

    queryElement: function (selector, timeout = 10000) {
      if (typeof selector !== "string") throw new Error("Invalid selector.");
      if (typeof timeout !== "number") throw new Error("Invalid timeout.");

      let element = document.querySelector(selector);
      if (element) return Promise.resolve(element);

      return new Promise((resolve) => {
        const observer = new MutationObserver((mutationsList, obs) => {
          element = document.querySelector(selector);

          if (element) {
            obs.disconnect();
            clearTimeout(timer);
            resolve(element);
          }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        const timer = setTimeout(() => {
          observer.disconnect();
          resolve(null);
        }, timeout);
      });
    },

    insertSaveButton: function (headerElement) {
      if (!(headerElement instanceof Element))
        throw new Error("Invalid element.");

      const buttonClassName = this.save_button_class;
      if (headerElement.querySelector("." + buttonClassName)) return;

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
        this.saveWorkOrder(this.work_order);
      });

      saveButton.appendChild(iconSave);
      saveButton.appendChild(spanSave);
      headerElement.appendChild(saveButton);
    },

    insertRemoveButton: function (headerElement) {
      if (!(headerElement instanceof Element))
        throw new Error("Invalid element.");

      const buttonClassName = this.remove_button_class;
      if (headerElement.querySelector("." + buttonClassName)) return;

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
        this.removeWorkOrder(this.work_order);
      });

      removeButton.appendChild(iconRemove);
      removeButton.appendChild(spanRemove);
      headerElement.appendChild(removeButton);
    },

    saveWorkOrder: async function (workOrder) {
      if (typeof workOrder !== "object") throw new Error("Invalid work order.");

      chrome.storage.local.get("work_orders", (result) => {
        const data = result.work_orders || {};
        if (typeof data !== "object") throw new Error("Invalid map data.");

        this.work_orders = new Map(Object.entries(data));

        this.work_orders.set(workOrder.number, workOrder);

        chrome.storage.local.set(
          { work_orders: Object.fromEntries(this.work_orders) },
          () => {}
        );
      });
    },

    removeWorkOrder: async function (workOrder) {
      if (typeof workOrder !== "object") throw new Error("Invalid work order.");

      chrome.storage.local.get("work_orders", (result) => {
        const data = result.work_orders || {};
        if (typeof data !== "object") throw new Error("Invalid map data.");

        this.work_orders = new Map(Object.entries(data));

        if (!this.work_orders.has(workOrder.number)) return;

        this.work_orders.delete(workOrder.number);

        chrome.storage.local.set(
          { work_orders: Object.fromEntries(this.work_orders) },
          () => {}
        );
      });
    },
  };

  content.init();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" && !changes.work_orders) return;

    const allButtons = document.querySelectorAll(".nss-button");
    if (!allButtons) return;

    allButtons.forEach((button) => button.remove());
    content.init();
  });
})();
