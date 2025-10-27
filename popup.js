document.addEventListener("DOMContentLoaded", () => {
  if (typeof browser === "undefined") globalThis.browser = chrome;

  const plugin = {
    websites: ["buildertrend.net", "appfolio.com"],
    work_orders: new Map(),

    start: async function () {
      const clearButton = document.querySelector("footer button.clear");
      if (!clearButton) throw new Error("Clear button not found.");

      // propagate work orders from the storage
      browser.storage.local.get("work_orders", (result) => {
        const data = result.work_orders || {};
        if (typeof data !== "object") throw new Error("Invalid map data.");

        this.work_orders = new Map(Object.entries(data));

        // show the list items
        const workOrdersList = document.querySelector("#work-orders");
        if (!workOrdersList) throw new Error("Work Order list not found.");

        const counter = document.querySelector("#total-count .value");

        if (this.work_orders.size > 0) {
          this.work_orders.forEach((work_order) => {
            this.showWorkOrder(workOrdersList, work_order);
          });

          // if work orders are not empty, show clear all button
          clearButton.addEventListener("click", () => {
            // BUG: multiple confirmation when deleting 1 by 1 THEN clearing all at once
            // confirm("Clearing all work orders cannot be undone. Continue?");

            browser.storage.local.clear();
            clearButton.setAttribute("data-hidden", true);
          });

          clearButton.setAttribute("data-hidden", false);

          if (counter) counter.textContent = this.work_orders.size;
        } else {
          const p = document.createElement("p");
          p.textContent = "You currently have no work orders saved.";
          workOrdersList.appendChild(p);

          clearButton.setAttribute("data-hidden", true);

          if (counter) counter.textContent = 0;
        }

        this.load(false);
      });
    },

    load: function (bool) {
      if (typeof bool !== "boolean") throw new Error("Invalid bool.");

      setTimeout(() => {
        document.body.setAttribute("data-loading", bool);
      }, 0);
    },

    terminate: function () {
      document.body.setAttribute("data-running", false);
    },

    alert(msg, option = { timeout: 10000 }) {
      if (typeof msg !== "string") throw new Error("Invalid string.");
      if (option.timeout !== undefined && typeof option.timeout !== "number")
        throw new Error("Invalid timeout.");

      const flash = document.querySelector("#flash");
      if (!flash) throw new Error("Flash is missing.");

      const li = document.createElement("li");
      const p = document.createElement("p");
      p.className = "alert";
      p.textContent = "\u26A0 " + msg;

      li.appendChild(p);
      flash.appendChild(li);

      li.addEventListener("click", () => {
        flash.removeChild(li);
      });

      setTimeout(() => {
        flash.removeChild(li);
      }, option.timeout);
    },

    error(msg, option = { persist: false, timeout: 10000 }) {
      if (typeof msg !== "string") throw new Error("Invalid string.");
      if (option.timeout !== undefined && typeof option.timeout !== "number")
        throw new Error("Invalid timeout.");

      const flash = document.querySelector("#flash");
      if (!flash) throw new Error("Flash is missing.");

      const li = document.createElement("li");
      const p = document.createElement("p");
      p.setAttribute("data-critical", option.persist);
      p.className = "error";
      p.textContent = "\u26A0 " + msg;

      li.appendChild(p);
      flash.appendChild(li);

      if (!option.persist) {
        li.addEventListener("click", () => {
          flash.removeChild(li);
        });

        setTimeout(() => {
          flash.removeChild(li);
        }, option.timeout);
      }
    },

    criticalError: function (msg) {
      if (typeof msg !== "string") throw new Error("Invalid string.");

      this.error(msg, { persist: true });
      this.terminate();
    },

    showWorkOrder: function (listElement, work_order) {
      if (!listElement instanceof Element)
        throw new Error("Invalid list element.");

      if (!work_order || typeof work_order !== "object")
        throw new Error("Invalid work order.");

      const li = document.createElement("li");

      const workOrderNo = document.createElement("div");
      workOrderNo.className = "work-order-no";

      const pWorkOrderNo = document.createElement("p");
      pWorkOrderNo.className = "copyable";
      pWorkOrderNo.textContent = work_order.number || "";

      workOrderNo.appendChild(pWorkOrderNo);
      li.appendChild(workOrderNo);

      const unit = document.createElement("div");
      unit.className = "unit";

      const pStreet = document.createElement("p");
      pStreet.className = "street copyable";
      pStreet.textContent = work_order.street || "";

      const pCityStateZip = document.createElement("p");

      const spanCity = document.createElement("span");
      spanCity.className = "city";
      spanCity.textContent = (work_order.city || "") + ", ";

      const spanState = document.createElement("span");
      spanState.className = "state";
      spanState.textContent = work_order.state || "";

      const spanZip = document.createElement("span");
      spanZip.className = "zip";
      spanZip.textContent = " " + work_order.zip || "";

      pCityStateZip.appendChild(spanCity);
      pCityStateZip.appendChild(spanState);
      pCityStateZip.appendChild(spanZip);
      unit.appendChild(pStreet);
      unit.appendChild(pCityStateZip);
      li.appendChild(unit);

      const description = document.createElement("div");
      description.className = "description";
      description.title = work_order.description || "";

      const pDescription = document.createElement("p");
      pDescription.className = "copyable";
      pDescription.textContent = work_order.description || "";

      description.appendChild(pDescription);
      li.appendChild(description);

      const actions = document.createElement("div");
      actions.className = "actions";

      const buttonInsert = document.createElement("button");
      buttonInsert.setAttribute("type", "button");
      buttonInsert.className = "insert";
      buttonInsert.title = "Fill";

      const iconInsert = document.createElement("i");
      iconInsert.className = "icon";

      const svgInsert = `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640">
              <path
                d="M539.3 64.1C549.2 63.3 558.9 67.1 565.9 74.1C572.9 81.1 576.7 90.8 575.9 100.7C571.9 150 558.5 226.9 529.6 300.4C527.8 304.9 524.1 308.3 519.4 309.7L438.5 334C434.6 335.2 432 338.7 432 342.8C432 347.9 436.1 352 441.2 352L479.8 352C491.8 352 499.5 364.8 493.3 375.1C489.3 381.8 485 388.3 480.6 394.7C478.6 397.6 475.6 399.7 472.2 400.8L374.5 430C370.6 431.2 368 434.7 368 438.8C368 443.9 372.1 448 377.2 448L393.2 448C407.8 448 414.2 465.4 402 473.4C334 518.4 264.3 516.7 219.6 504.7C206.9 501.3 195.6 494.8 185.2 486.8L112 560C103.2 568.8 88.8 568.8 80 560C71.2 551.2 71.2 536.8 80 528L160 448L160.5 448.5C161.2 447.2 162.1 446 163.2 444.9L320 288C328.8 279.2 328.8 264.8 320 256C311.2 247.2 296.8 247.2 288 256L153.7 390.2C144.8 399.1 129.7 394.6 128.7 382C124.4 328.8 138 258.9 201.3 195.6C292.4 104.5 455.5 70.9 539.2 64.1z"
              />
            </svg>
          `;
      iconInsert.innerHTML = svgInsert;

      const spanInsert = document.createElement("span");
      spanInsert.className = "sr-only";
      spanInsert.textContent = "Insert";

      buttonInsert.addEventListener("click", () => {
        this.fillOutJob(work_order);
      });

      const buttonDelete = document.createElement("button");
      buttonDelete.setAttribute("type", "button");
      buttonDelete.className = "delete";
      buttonDelete.title = "Remove";

      const iconDelete = document.createElement("i");
      iconDelete.className = "icon";

      const svgDelete = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640">
      <path
      d="M232.7 69.9L224 96L128 96C110.3 96 96 110.3 96 128C96 145.7 110.3 160 128 160L512 160C529.7 160 544 145.7 544 128C544 110.3 529.7 96 512 96L416 96L407.3 69.9C402.9 56.8 390.7 48 376.9 48L263.1 48C249.3 48 237.1 56.8 232.7 69.9zM512 208L128 208L149.1 531.1C150.7 556.4 171.7 576 197 576L443 576C468.3 576 489.3 556.4 490.9 531.1L512 208z"
      />
      </svg>
      `;
      iconDelete.innerHTML = svgDelete;

      const spanDelete = document.createElement("span");
      spanDelete.className = "sr-only";
      spanDelete.textContent = "Delete";

      buttonDelete.addEventListener("click", () => {
        this.removeWorkOrder(work_order);
      });

      buttonInsert.appendChild(iconInsert);
      buttonInsert.appendChild(spanInsert);

      buttonDelete.appendChild(iconDelete);
      buttonDelete.appendChild(spanDelete);

      actions.appendChild(buttonInsert);
      actions.appendChild(buttonDelete);

      li.appendChild(actions);

      listElement.appendChild(li);
    },

    removeWorkOrder: async function (work_order) {
      if (!work_order || typeof work_order !== "object")
        throw new Error("Invalid work order.");

      browser.storage.local.get("work_orders", (result) => {
        const data = result.work_orders || {};
        if (typeof data !== "object") throw new Error("Invalid map data.");

        this.work_orders = new Map(Object.entries(data));

        if (!this.work_orders.has(work_order.number || "")) return;

        this.work_orders.delete(work_order.number);

        browser.storage.local.set(
          { work_orders: Object.fromEntries(this.work_orders) },
          () => {}
        );
      });
    },

    fillOutJob: async function (work_order) {
      if (typeof work_order !== "object") throw new Error("Invalid work order");

      browser.runtime.sendMessage({
        type: "FILL_JOB_REQUEST",
        payload: work_order,
      });
    },
  };

  window.addEventListener("load", () => {
    plugin.start();
  });

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" && !changes.work_orders) return;

    const workOrders = document.querySelectorAll("#work-orders > li");
    if (!workOrders) return;

    workOrders.forEach((order) => order.remove());
    plugin.start();
  });

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "CRITICAL_ERROR") {
      plugin.criticalError(msg.payload || "Critical Error found!");
    }

    if (msg.type === "FLASH_ALERT") {
      plugin.alert(msg.payload);
    }

    if (msg.type === "FLASH_ERROR") {
      plugin.error(msg.payload);
    }
  });
});
