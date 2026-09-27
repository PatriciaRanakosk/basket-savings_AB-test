(() => {
  'use strict';

  const EXPERIMENT_NAME = 'Basket Savings Experiment';

  const SELECTORS = {
    desktopItem: '[data-testid="desktopLineItems"]',
    mobileItem: '[data-testid="mobileLineItems"]',

    sku: '[data-testid="lineItemSku"]',
    productLink: 'a[href^="/p/"]',
    currentPrice: '[data-testid="lineItemNowPrice"]',
    pricesContainer: '[class*="LineItems_prices"]',

    previousPrice: '[data-testid="discountPrice"]',
    discountPercentage: '[data-testid="discountPercentage"]',

    subtotalLabel: '[data-testid="subtotalLabel"]',
    subtotalAmount: '[data-testid="subtotalAmount"]',
    totalLabel: '[data-testid="totalLabel"]',
    totalAmount: '[data-testid="totalAmount"]',

    applyCodeButton: '[data-testid="applyCodeButton"]'
  };

  const discountCache = new Map();

  let updateTimer = null;
  let processing = false;
  let rerunRequested = false;
  let eventsAttached = false;


  /*
   * Price helpers
   */

  function parsePrice(value) {
    const parsed = Number(
      String(value || '').replace(/[^\d.-]/g, '')
    );

    return Number.isFinite(parsed)
      ? Math.abs(parsed)
      : 0;
  }


  function formatPrice(value) {
    return `£${value.toFixed(2)}`;
  }


  /*
   * Quantity
   *
   * The basket uses a custom combobox rather than
   * a native select element.
   */

  function getQuantity(sku, lineItem) {
    const quantityLabel = document.getElementById(
      `basket-qty-selector-${sku}-combo-label`
    );

    if (quantityLabel) {
      const quantity = parseInt(
        quantityLabel.textContent.trim(),
        10
      );

      if (Number.isFinite(quantity) && quantity > 0) {
        return quantity;
      }
    }

    const combobox = lineItem.querySelector(
      '[role="combobox"][id^="basket-qty-selector-"]'
    );

    if (combobox) {
      const label = combobox.querySelector(
        'span[id$="-combo-label"]'
      );

      const quantity = parseInt(
        label?.textContent?.trim(),
        10
      );

      if (Number.isFinite(quantity) && quantity > 0) {
        return quantity;
      }
    }

    return 1;
  }


  /*
   * Basket products
   */

  function getBasketProducts() {
    const elements = document.querySelectorAll(
      `${SELECTORS.desktopItem}, ${SELECTORS.mobileItem}`
    );

    const products = new Map();

    elements.forEach(lineItem => {
      const skuElement = lineItem.querySelector(
        SELECTORS.sku
      );

      const linkElement = lineItem.querySelector(
        SELECTORS.productLink
      );

      const priceElement = lineItem.querySelector(
        SELECTORS.currentPrice
      );

      if (
        !skuElement ||
        !linkElement ||
        !priceElement
      ) {
        return;
      }

      const sku = skuElement.textContent.trim();

      const quantity = getQuantity(
        sku,
        lineItem
      );

      /*
       * The basket price represents the complete
       * current value of the line.
       */

      const currentLineValue = parsePrice(
        priceElement.textContent
      );

      /*
       * Desktop and mobile markup can both exist
       * in the DOM, so products are deduplicated
       * using their SKU.
       */

      if (!products.has(sku)) {
        products.set(sku, {
          sku,

          productUrl: linkElement.href,

          quantity,

          currentLineValue,

          currentUnitPrice:
            currentLineValue / quantity,

          elements: []
        });
      }

      products
        .get(sku)
        .elements
        .push(lineItem);
    });

    return Array.from(products.values());
  }


  /*
   * PDP discount data
   */

  function fetchDiscount(productUrl, sku) {
    if (discountCache.has(sku)) {
      return discountCache.get(sku);
    }

    const request = fetch(
      productUrl,
      {
        credentials: 'same-origin'
      }
    )

      .then(response => {
        if (!response.ok) {
          throw new Error(
            `PDP request failed: ${response.status}`
          );
        }

        return response.text();
      })

      .then(html => {
        const pdp = new DOMParser().parseFromString(
          html,
          'text/html'
        );

        const previousPriceElement = pdp.querySelector(
          SELECTORS.previousPrice
        );

        const percentageElement = pdp.querySelector(
          SELECTORS.discountPercentage
        );

        /*
         * No PDP Was price means there is no
         * product level discount to display.
         */

        if (
          !previousPriceElement ||
          !percentageElement
        ) {
          return null;
        }

        return {
          previousUnitPrice: parsePrice(
            previousPriceElement.textContent
          ),

          discountPercentage:
            percentageElement.textContent.trim()
        };
      })

      .catch(error => {
        /*
         * Remove failed requests from the cache so
         * they can be retried on a later update.
         */

        discountCache.delete(sku);

        console.warn(
          `[${EXPERIMENT_NAME}] PDP request failed for ${sku}`,
          error
        );

        return null;
      });

    discountCache.set(
      sku,
      request
    );

    return request;
  }


  /*
   * Product level saving message
   */

  function injectProductMessage(
    product,
    discount
  ) {
    /*
     * The PDP Was price is per unit.
     * The basket displays line totals, so the
     * Was price must also account for quantity.
     */

    const fullWasPrice =
      discount.previousUnitPrice *
      product.quantity;

    product.elements.forEach(lineItem => {
      const priceContainer = lineItem.querySelector(
        SELECTORS.pricesContainer
      );

      if (!priceContainer) {
        return;
      }

      let message = lineItem.querySelector(
        `[data-basket-savings="${product.sku}"]`
      );

      if (!message) {
        message = document.createElement('div');

        message.className =
          'basket-savings-product';

        message.dataset.basketSavings =
          product.sku;

        message.innerHTML = `
          <span class="basket-savings-product__percentage"></span>
          <span class="basket-savings-product__was"></span>
        `;

        priceContainer.prepend(message);
      }

      const percentage = message.querySelector(
        '.basket-savings-product__percentage'
      );

      const wasPrice = message.querySelector(
        '.basket-savings-product__was'
      );

      if (percentage) {
        percentage.textContent =
          discount.discountPercentage.toUpperCase();
      }

      if (wasPrice) {
        wasPrice.textContent =
          formatPrice(fullWasPrice);
      }
    });
  }


  /*
   * Product calculation
   */

  function calculateProduct(
    product,
    discount
  ) {
    /*
     * Full price product.
     */

    if (!discount) {
      return {
        sku: product.sku,

        quantity: product.quantity,

        discounted: false,

        originalUnitPrice:
          product.currentUnitPrice,

        currentUnitPrice:
          product.currentUnitPrice,

        originalLineValue:
          product.currentLineValue,

        currentLineValue:
          product.currentLineValue,

        productSaving: 0
      };
    }

    /*
     * Discounted product.
     */

    const originalLineValue =
      discount.previousUnitPrice *
      product.quantity;

    const currentLineValue =
      product.currentLineValue;

    const productSaving = Math.max(
      0,
      originalLineValue -
        currentLineValue
    );

    return {
      sku: product.sku,

      quantity: product.quantity,

      discounted: true,

      originalUnitPrice:
        discount.previousUnitPrice,

      currentUnitPrice:
        product.currentUnitPrice,

      originalLineValue,

      currentLineValue,

      productSaving
    };
  }


  /*
   * Native final total
   */

  function getNativeTotal() {
    const totalAmount = document.querySelector(
      SELECTORS.totalAmount
    );

    if (!totalAmount) {
      return 0;
    }

    return parsePrice(
      totalAmount.textContent
    );
  }


  /*
   * Native voucher saving
   *
   * Voucher eligibility and exclusions remain
   * controlled by the site's existing pricing
   * logic rather than being recreated here.
   */

  function getVoucherSaving() {
    const totalLabel = document.querySelector(
      SELECTORS.totalLabel
    );

    if (!totalLabel) {
      return 0;
    }

    const totalRow =
      totalLabel.parentElement;

    const totalsContainer =
      totalRow?.parentElement;

    if (!totalsContainer) {
      return 0;
    }

    const rows = Array.from(
      totalsContainer.children
    );

    for (const row of rows) {
      /*
       * Ignore the Product saving row introduced
       * by this experiment.
       */

      if (
        row.hasAttribute(
          'data-basket-product-saving'
        )
      ) {
        continue;
      }

      const text = row.textContent
        ?.replace(/\s+/g, ' ')
        .trim();

      if (!text) {
        continue;
      }

      /*
       * Find the site's existing Saving row.
       */

      if (
        /^Saving\b/i.test(text) &&
        !/^Product saving\b/i.test(text)
      ) {
        const match = text.match(
          /£\s*([\d,.]+)/
        );

        if (match) {
          return parsePrice(match[1]);
        }
      }
    }

    return 0;
  }


  /*
   * Basket totals
   */

  function updateTotals(
    nativeTotal,
    totalProductSaving,
    voucherSaving
  ) {
    const subtotalAmount =
      document.querySelector(
        SELECTORS.subtotalAmount
      );

    const totalLabel =
      document.querySelector(
        SELECTORS.totalLabel
      );

    if (
      !subtotalAmount ||
      !totalLabel
    ) {
      return;
    }

    /*
     * Reconstruct the full price basket value.
     *
     * Full price subtotal =
     * final total
     * + product savings
     * + voucher savings
     */

    const fullPriceSubtotal =
      nativeTotal +
      totalProductSaving +
      voucherSaving;

    subtotalAmount.textContent =
      formatPrice(fullPriceSubtotal);

    const totalRow =
      totalLabel.parentElement;

    if (!totalRow) {
      return;
    }

    let savingRow = document.querySelector(
      '[data-basket-product-saving]'
    );

    /*
     * Remove the experiment row if no products
     * currently have a product level saving.
     */

    if (totalProductSaving <= 0) {
      savingRow?.remove();
      return;
    }

    if (!savingRow) {
      savingRow =
        document.createElement('div');

      savingRow.className =
        'basket-savings-total';

      savingRow.dataset.basketProductSaving =
        'true';

      savingRow.innerHTML = `
        <span class="basket-savings-total__label">
          Product saving
        </span>

        <span
          class="basket-savings-total__amount"
          data-basket-product-saving-amount
        ></span>
      `;

      totalRow.parentElement.insertBefore(
        savingRow,
        totalRow
      );
    }

    const savingAmount =
      savingRow.querySelector(
        '[data-basket-product-saving-amount]'
      );

    if (savingAmount) {
      savingAmount.textContent =
        `-${formatPrice(totalProductSaving)}`;
    }
  }


  /*
   * Process current basket state
   */

  async function processBasket() {
    if (processing) {
      rerunRequested = true;
      return;
    }

    processing = true;

    try {
      const products =
        getBasketProducts();

      if (!products.length) {
        return;
      }

      const calculatedProducts =
        await Promise.all(
          products.map(
            async product => {
              const discount =
                await fetchDiscount(
                  product.productUrl,
                  product.sku
                );

              if (discount) {
                injectProductMessage(
                  product,
                  discount
                );
              }

              return calculateProduct(
                product,
                discount
              );
            }
          )
        );

      const totalProductSaving =
        calculatedProducts.reduce(
          (sum, product) =>
            sum +
            product.productSaving,
          0
        );

      const nativeTotal =
        getNativeTotal();

      const voucherSaving =
        getVoucherSaving();

      updateTotals(
        nativeTotal,
        totalProductSaving,
        voucherSaving
      );

    } catch (error) {
      console.error(
        `[${EXPERIMENT_NAME}]`,
        error
      );

    } finally {
      processing = false;

      if (rerunRequested) {
        rerunRequested = false;
        scheduleUpdate();
      }
    }
  }


  /*
   * Debounced basket update
   */

  function scheduleUpdate(delay = 900) {
    clearTimeout(updateTimer);

    /*
     * Give the site's React state time to update
     * quantities, line prices and totals before
     * reading the basket again.
     */

    updateTimer = setTimeout(
      processBasket,
      delay
    );
  }


  /*
   * Relevant basket interactions
   */

  function attachEvents() {
    if (eventsAttached) {
      return;
    }

    eventsAttached = true;

    document.addEventListener(
      'click',
      event => {
        /*
         * Quantity selector interaction.
         */

        const quantityControl =
          event.target.closest(
            '[id^="basket-qty-selector-"], [data-testid="sortByInput"]'
          );

        if (quantityControl) {
          scheduleUpdate();
          return;
        }

        const control =
          event.target.closest(
            'button, a'
          );

        if (!control) {
          return;
        }

        /*
         * Product removal.
         */

        if (
          control.textContent
            ?.trim()
            .toLowerCase() ===
          'remove'
        ) {
          scheduleUpdate();
          return;
        }

        /*
         * Voucher application may require slightly
         * longer for the site's totals to update.
         */

        if (
          control.matches(
            SELECTORS.applyCodeButton
          )
        ) {
          scheduleUpdate(1400);
        }
      },
      true
    );
  }


  /*
   * Experiment lifecycle
   */

  function basketReady() {
    return Boolean(
      document.querySelector(
        `${SELECTORS.desktopItem}, ${SELECTORS.mobileItem}`
      )

      &&

      document.querySelector(
        SELECTORS.subtotalAmount
      )

      &&

      document.querySelector(
        SELECTORS.totalAmount
      )

      &&

      document.querySelector(
        SELECTORS.totalLabel
      )
    );
  }


  async function start() {
    attachEvents();
    await processBasket();
  }


  /*
   * Initialise immediately when possible.
   * Otherwise wait for the site's initial React
   * basket render and disconnect the observer.
   */

  if (basketReady()) {
    start();

  } else {
    const initialObserver =
      new MutationObserver(() => {
        if (!basketReady()) {
          return;
        }

        initialObserver.disconnect();
        start();
      });

    initialObserver.observe(
      document.body,
      {
        childList: true,
        subtree: true
      }
    );
  }

})();
