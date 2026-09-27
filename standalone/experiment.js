(() => {
  'use strict';

  const SELECTORS = {
    lineItems: '[data-testid="desktopLineItems"], [data-testid="mobileLineItems"]',
    sku: '[data-testid="lineItemSku"]',
    quantity: '[data-testid="basketQuantitySelector"]',
    nowPrice: '[data-testid="lineItemNowPrice"]',
    wasPrice: '[data-testid="lineItemWasPrice"]',
    productLink: 'a[href*="/p/"], a[href*="/product/"]',
    pricesContainer: '[class*="LineItems_prices"]',
    subtotal: '[data-testid="subtotalAmount"]',
    voucherSaving: '[data-testid="savingAmount"]',
    total: '[data-testid="totalAmount"]',
    totalLabel: '[data-testid="totalLabel"]',
    pdpWasPrice: '[data-testid="discountPrice"]',
    pdpDiscountPercentage: '[data-testid="discountPercentage"]'
  };

  const pdpCache = new Map();

  let observer = null;
  let observerConnected = false;
  let updateTimer = null;
  let processing = false;
  let rerunRequested = false;


  // Price helpers
  function parsePrice(value) {
    const parsed = Number(
      String(value || '')
        .replace(/,/g, '')
        .replace(/[^\d.-]/g, '')
    );

    return Number.isFinite(parsed) ? Math.abs(parsed) : 0;
  }

  function formatPrice(value) {
    return `£${value.toFixed(2)}`;
  }

  function roundMoney(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }


  // Basket helpers
  function getAllLineItems() {
    return Array.from(document.querySelectorAll(SELECTORS.lineItems));
  }

  function getSku(lineItem) {
    return lineItem.querySelector(SELECTORS.sku)?.textContent?.trim() || '';
  }

  function getElementsForSku(sku) {
    return getAllLineItems().filter(item => getSku(item) === sku);
  }


  /*
   * Quantity can come from different DOM structures depending
   * on the breakpoint. Mobile exposes the selected quantity
   * through aria-label, with fallbacks for desktop/other states.
   */
  function getQuantity(lineItem, sku) {
    const root = lineItem.querySelector(SELECTORS.quantity);

    if (root) {
      const select = root.querySelector('select');

      if (select) {
        const quantity = parseInt(select.value, 10);

        if (Number.isFinite(quantity) && quantity > 0) {
          return quantity;
        }
      }

      const combo = root.matches('[role="combobox"]')
        ? root
        : root.querySelector('[role="combobox"]');

      if (combo) {
        const ariaLabelQuantity = parseInt(
          combo.getAttribute('aria-label'),
          10
        );

        if (Number.isFinite(ariaLabelQuantity) && ariaLabelQuantity > 0) {
          return ariaLabelQuantity;
        }

        const ariaValueQuantity = parseInt(
          combo.getAttribute('aria-valuenow'),
          10
        );

        if (Number.isFinite(ariaValueQuantity) && ariaValueQuantity > 0) {
          return ariaValueQuantity;
        }

        const labelledBy = combo.getAttribute('aria-labelledby');

        if (labelledBy) {
          const ids = labelledBy.split(/\s+/).filter(Boolean);

          for (const id of ids) {
            const quantity = parseInt(
              document.getElementById(id)?.textContent?.trim(),
              10
            );

            if (Number.isFinite(quantity) && quantity > 0) {
              return quantity;
            }
          }
        }

        const textQuantity = parseInt(combo.textContent?.trim(), 10);

        if (Number.isFinite(textQuantity) && textQuantity > 0) {
          return textQuantity;
        }
      }
    }

    const exactLabel = document.getElementById(
      `basket-qty-selector-${sku}-combo-label`
    );

    if (exactLabel) {
      const quantity = parseInt(exactLabel.textContent.trim(), 10);

      if (Number.isFinite(quantity) && quantity > 0) {
        return quantity;
      }
    }

    return 1;
  }


  function getProductUrl(elements) {
    for (const element of elements) {
      const link = element.querySelector(SELECTORS.productLink);

      if (link?.href) {
        return link.href;
      }
    }

    // Fallback for product links that sit higher in the line item structure
    for (const element of elements) {
      const skuElement = element.querySelector(SELECTORS.sku);
      let parent = skuElement?.parentElement;
      let depth = 0;

      while (parent && depth < 8) {
        const link = parent.querySelector(SELECTORS.productLink);

        if (link?.href) {
          return link.href;
        }

        parent = parent.parentElement;
        depth++;
      }
    }

    return null;
  }


  /*
   * Both desktop and mobile line items can exist in the DOM at
   * the same time. Grouping by SKU prevents the same product
   * from being included twice in the calculations.
   */
  function readBasket() {
    const groups = new Map();

    getAllLineItems().forEach(lineItem => {
      const sku = getSku(lineItem);
      const nowPrice = lineItem.querySelector(SELECTORS.nowPrice);

      if (!sku || !nowPrice) {
        return;
      }

      if (!groups.has(sku)) {
        groups.set(sku, []);
      }

      groups.get(sku).push(lineItem);
    });

    const products = [];

    groups.forEach((elements, sku) => {
      const source =
        elements.find(element => element.offsetParent !== null) || elements[0];

      if (!source) {
        return;
      }

      const nowElement = source.querySelector(SELECTORS.nowPrice);

      if (!nowElement) {
        return;
      }

      const quantity = getQuantity(source, sku);

      /*
       * lineItemNowPrice already contains the full line value
       * for the selected quantity, so it must not be multiplied
       * by quantity again.
       */
      const currentLineTotal = parsePrice(nowElement.textContent);

      /*
       * A Was price can also be introduced after a voucher is
       * applied. Capture it here, but classify the saving later
       * so voucher discounts are not counted twice.
       */
      const basketWasElement = source.querySelector(SELECTORS.wasPrice);
      let basketWasLineTotal = null;

      if (basketWasElement) {
        const basketWas = parsePrice(basketWasElement.textContent);

        if (basketWas > currentLineTotal) {
          basketWasLineTotal = basketWas;
        }
      }

      products.push({
        sku,
        quantity,
        currentLineTotal,
        basketWasLineTotal,
        productUrl: getProductUrl(elements)
      });
    });

    return products;
  }


  /*
   * PDP data is used as the source of truth for discounts that
   * existed before a basket voucher was applied. Results are
   * cached by SKU to avoid fetching the same PDP repeatedly.
   */
  async function getPdpPricing(productUrl, sku) {
    if (!productUrl) {
      return null;
    }

    if (pdpCache.has(sku)) {
      return pdpCache.get(sku);
    }

    const request = fetch(productUrl, { credentials: 'same-origin' })
      .then(response => {
        if (!response.ok) {
          throw new Error(`PDP returned ${response.status}`);
        }

        return response.text();
      })
      .then(html => {
        const pdp = new DOMParser().parseFromString(html, 'text/html');

        const wasElement = pdp.querySelector(SELECTORS.pdpWasPrice);
        const percentageElement = pdp.querySelector(
          SELECTORS.pdpDiscountPercentage
        );

        if (!wasElement) {
          return null;
        }

        const wasUnitPrice = parsePrice(wasElement.textContent);

        if (!wasUnitPrice) {
          return null;
        }

        return {
          wasUnitPrice,
          percentageText:
            percentageElement?.textContent?.trim()?.toUpperCase() || null
        };
      })
      .catch(error => {
        pdpCache.delete(sku);
        console.error('Basket Savings: PDP request failed.', error);
        return null;
      });

    pdpCache.set(sku, request);

    return request;
  }


  /*
   * Product saving only represents the original PDP discount.
   * Voucher discounts are kept separate to avoid double counting.
   */
  async function calculateProduct(product) {
    const pdp = await getPdpPricing(product.productUrl, product.sku);

    if (!pdp?.wasUnitPrice) {
      return {
        ...product,
        discounted: false,
        productWasLineTotal: null,
        productSaving: 0,
        percentageText: null
      };
    }

    const productWasLineTotal = roundMoney(
      pdp.wasUnitPrice * product.quantity
    );

    let percentage = 0;

    if (pdp.percentageText) {
      const match = pdp.percentageText.match(/(\d+(?:\.\d+)?)\s*%/);

      if (match) {
        percentage = Number(match[1]);
      }
    }

    let productSaving = 0;

    /*
     * Calculate the original product discount independently from
     * the basket's current price because that price may already
     * include an additional voucher discount.
     */
    if (percentage > 0) {
      productSaving = roundMoney(
        productWasLineTotal * (percentage / 100)
      );
    } else if (!product.basketWasLineTotal) {
      productSaving = roundMoney(
        productWasLineTotal - product.currentLineTotal
      );
    }

    if (productSaving <= 0) {
      return {
        ...product,
        discounted: false,
        productWasLineTotal: null,
        productSaving: 0,
        percentageText: null
      };
    }

    return {
      ...product,
      discounted: true,
      productWasLineTotal,
      productSaving,
      percentageText:
        pdp.percentageText ||
        `SAVE ${Math.round(
          (productSaving / productWasLineTotal) * 100
        )}%`
    };
  }


  // Render the saving message against every matching responsive line item
  function renderProduct(result) {
    const elements = getElementsForSku(result.sku);

    elements.forEach(lineItem => {
      let message = lineItem.querySelector(
        '[data-basket-savings-product]'
      );

      if (!result.discounted) {
        message?.remove();
        return;
      }

      const nowPrice = lineItem.querySelector(SELECTORS.nowPrice);

      const priceContainer =
        lineItem.querySelector(SELECTORS.pricesContainer) ||
        nowPrice?.parentElement;

      if (!priceContainer) {
        return;
      }

      if (!message) {
        message = document.createElement('div');
        message.className = 'basket-savings-product';
        message.setAttribute('data-basket-savings-product', result.sku);

        message.innerHTML = `
          <span class="basket-savings-product__percentage"></span>
          <span class="basket-savings-product__was"></span>
        `;

        priceContainer.prepend(message);
      }

      message.querySelector(
        '.basket-savings-product__percentage'
      ).textContent = result.percentageText;

      message.querySelector(
        '.basket-savings-product__was'
      ).textContent = formatPrice(result.productWasLineTotal);
    });
  }


  function getNativeTotal() {
    const totals = Array.from(
      document.querySelectorAll(SELECTORS.total)
    );

    const visible = totals.find(
      element => element.offsetParent !== null
    );

    if (visible) {
      return parsePrice(visible.textContent);
    }

    for (const element of totals) {
      const value = parsePrice(element.textContent);

      if (value > 0) {
        return value;
      }
    }

    return 0;
  }


  /*
   * Read the site's native voucher Saving rather than deriving
   * it from line item prices. This keeps voucher savings separate
   * from the product savings calculated from PDP data.
   */
  function getVoucherSaving() {
    const elements = Array.from(
      document.querySelectorAll(SELECTORS.voucherSaving)
    );

    const visible = elements.find(
      element =>
        element.offsetParent !== null &&
        !element.closest('[data-basket-product-saving]')
    );

    if (visible) {
      return parsePrice(visible.textContent);
    }

    for (const element of elements) {
      if (element.closest('[data-basket-product-saving]')) {
        continue;
      }

      const value = parsePrice(element.textContent);

      if (value > 0) {
        return value;
      }
    }

    return 0;
  }


  function renderTotals(productSaving, voucherSaving, nativeTotal) {
    /*
     * Reconstruct the original basket value:
     *
     * final total + voucher saving + product saving
     */
    const fullPriceSubtotal = roundMoney(
      nativeTotal + voucherSaving + productSaving
    );

    document.querySelectorAll(SELECTORS.subtotal).forEach(subtotal => {
      subtotal.textContent = formatPrice(fullPriceSubtotal);
    });

    document.querySelectorAll(SELECTORS.totalLabel).forEach(totalLabel => {
      const totalRow = totalLabel.parentElement;
      const totalsContainer = totalRow?.parentElement;

      if (!totalsContainer) {
        return;
      }

      let savingRow = totalsContainer.querySelector(
        '[data-basket-product-saving]'
      );

      if (productSaving <= 0) {
        savingRow?.remove();
        return;
      }

      if (!savingRow) {
        savingRow = document.createElement('div');
        savingRow.className = 'basket-savings-total';
        savingRow.setAttribute('data-basket-product-saving', 'true');

        savingRow.innerHTML = `
          <span class="basket-savings-total__label">Product saving</span>
          <span class="basket-savings-total__amount"></span>
        `;

        totalsContainer.insertBefore(savingRow, totalRow);
      }

      savingRow.querySelector(
        '.basket-savings-total__amount'
      ).textContent = `-${formatPrice(productSaving)}`;
    });
  }


  /*
   * Disconnect the observer while we render our own changes.
   * Otherwise those changes would trigger another update and
   * create a MutationObserver loop.
   */
  function disconnectObserver() {
    if (observer && observerConnected) {
      observer.disconnect();
      observerConnected = false;
    }
  }

  function connectObserver() {
    if (!observer) {
      observer = new MutationObserver(mutations => {
        const relevant = mutations.some(mutation => {
          const target = mutation.target;

          if (
            target instanceof Element &&
            (
              target.closest('[data-basket-savings-product]') ||
              target.closest('[data-basket-product-saving]')
            )
          ) {
            return false;
          }

          return true;
        });

        if (relevant) {
          scheduleUpdate(500);
        }
      });
    }

    if (observerConnected) {
      return;
    }

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    observerConnected = true;
  }


  /*
   * Recalculate from the current DOM whenever the basket changes.
   * This covers quantity updates, removals, voucher changes and
   * products added without a full page refresh.
   */
  async function updateBasket() {
    if (processing) {
      rerunRequested = true;
      return;
    }

    processing = true;
    disconnectObserver();

    try {
      const products = readBasket();

      if (!products.length) {
        return;
      }

      // Capture native values before changing anything in the DOM
      const nativeTotal = getNativeTotal();
      const voucherSaving = getVoucherSaving();

      const results = await Promise.all(
        products.map(calculateProduct)
      );

      results.forEach(renderProduct);

      const productSaving = roundMoney(
        results.reduce(
          (total, product) => total + product.productSaving,
          0
        )
      );

      renderTotals(productSaving, voucherSaving, nativeTotal);
    } catch (error) {
      console.error('Basket Savings experiment failed.', error);
    } finally {
      processing = false;
      connectObserver();

      if (rerunRequested) {
        rerunRequested = false;
        scheduleUpdate(500);
      }
    }
  }


  // Debounce rapid React DOM changes into a single recalculation
  function scheduleUpdate(delay = 500) {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(updateBasket, delay);
  }


  /*
   * The basket is React rendered, so wait until the required
   * pricing elements exist before running the experiment.
   */
  function waitForBasket() {
    const basketReady =
      document.querySelector(SELECTORS.nowPrice) &&
      document.querySelector(SELECTORS.total);

    if (basketReady) {
      updateBasket();
      return;
    }

    const initialObserver = new MutationObserver(() => {
      const ready =
        document.querySelector(SELECTORS.nowPrice) &&
        document.querySelector(SELECTORS.total);

      if (!ready) {
        return;
      }

      initialObserver.disconnect();
      updateBasket();
    });

    initialObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }


  /*
   * Styles are injected here 
   */
  function injectStyles() {
    document.getElementById('basket-savings-styles')?.remove();

    const style = document.createElement('style');
    style.id = 'basket-savings-styles';

    style.textContent = `
      .basket-savings-product {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: 6px;
        margin-bottom: 3px;
        white-space: nowrap;
        font-size: 11px;
        line-height: 1.2;
      }

      .basket-savings-product__percentage {
        color: #d71920;
        font-weight: 700;
      }

      .basket-savings-product__was {
        color: #555;
        text-decoration: line-through;
      }

      .basket-savings-total {
        display: flex;
        justify-content: space-between;
        align-items: center;
        width: 100%;
        box-sizing: border-box;
        margin: 8px 0 12px;
        font-size: 14px;
        line-height: 1.4;
      }

      .basket-savings-total__label,
      .basket-savings-total__amount {
        color: #398536;
        font-weight: 500;
      }

      .basket-savings-total__amount {
        font-weight: 700;
      }
    `;

    document.head.appendChild(style);
  }


  injectStyles();
  waitForBasket();
})();
