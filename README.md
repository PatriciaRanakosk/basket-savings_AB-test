# Basket Savings A/B Test

This is my solution for the Basket Savings CRO Developer Challenge.

The idea behind the test is quite simple. Customers can see how much they are saving on the PDP, but when they get to the basket some of that information is lost.

The variation brings the product saving into the basket so customers can still see the value of the discount before they checkout.

## What I changed

For products that already have a discount on the PDP, I added:

**SAVE X% Was £Y**

I also added a **Product saving** row to the basket summary so customers can see how much they are saving across all discounted products.

I kept Product saving separate from the existing **Saving** value because the existing saving can come from a voucher or promotional code.

The Subtotal now represents the original value of the products before both types of saving are applied.

## How it works

I first used Chrome DevTools to understand how the basket and PDP were structured and what information was available.

The basket gives me the SKU, current price and quantity, but the original product price and discount percentage are available on the PDP.

Because of this, the script finds each product in the basket and uses its product URL to retrieve the relevant pricing information from the PDP.

From there it:

1. Finds the products in the basket.
2. Gets the SKU, current price and quantity.
3. Retrieves the PDP pricing for the product.
4. Gets the original price and discount percentage.
5. Calculates the correct Was price based on quantity.
6. Adds the saving message to the product.
7. Adds all the product savings together.
8. Updates the basket summary.

I also cache the PDP results by SKU so the same product page does not need to be requested again every time something changes in the basket.

## Savings calculation

One thing I had to account for was quantity.

If a product was originally £14.49 and the customer has 3 in the basket, I don't want to display:

**Was £14.49**

I want to display:

**Was £43.47**

So the calculation is:

**Original unit price × quantity = original line price**

For example:

£14.49 × 3 = £43.47

I also had to keep the original product discount separate from voucher discounts.

While testing, I found that applying a voucher can add or change the Was price in the basket. If I used that value as the product saving, the voucher could end up being counted twice.

For that reason, the PDP is used to identify the original product discount and the basket's existing Saving value is treated separately.

The Subtotal is then calculated as:

**Final total + promotional saving + product saving**

The final Total itself is not changed.

## Basket updates

The basket updates dynamically, so I couldn't rely on the script only running when the page first loads.

For example, the basket changes when someone changes the quantity, removes an item, applies a voucher or adds something from the recommendation carousel.

I used a `MutationObserver` to watch for these changes and rerun the calculations when needed.

I added a debounce because one basket action can create quite a few DOM changes at once.

I also disconnect the observer while my own changes are being added to the page. I ran into an issue during testing where the observer could keep reacting to its own changes, so this prevents that loop.

The elements added by the experiment also have their own data attributes. This means I can find and update them instead of adding the same element again.

## Desktop and mobile

This needed a bit of extra handling.

While testing responsive layouts, I found that desktop and mobile versions of the same basket item can both exist in the DOM.

That initially caused products to be counted more than once.

I fixed this by grouping products by SKU and using the visible version for the calculation.

I also found that the quantity selector behaves differently on mobile. The mobile version exposes the selected quantity through the combobox accessibility attributes, so I added this as another way of reading the quantity.

This means the same script can handle both desktop and mobile.

## Performance

I tried to keep the amount of work the script does reasonably small because this would be running as a client side experiment.

A few things I added to help with this:

* PDP responses are cached by SKU.
* Duplicate desktop and mobile products are grouped together.
* Basket changes are debounced.
* The observer is paused while the experiment updates the page.
* Existing experiment elements are updated instead of being recreated.

For an A/B test I think this gives a good balance between keeping the code simple and making sure it works when the basket changes.

## Assumptions

There are a few things this solution relies on:

* Basket products have a SKU available in the DOM.
* The product URL is available from the basket.
* The PDP contains the original product price and discount.
* Product pages can be requested from the same site.
* The existing basket Saving value is used for additional promotional savings.
* The relevant `data-testid` attributes remain available.

I used `data-testid` selectors where possible rather than relying on generated CSS class names.

## Limitations

The main limitation is that I'm fetching the PDP HTML to get the original pricing information.

For this experiment, that gives me access to information that isn't available directly in the basket.

If this was being built as a permanent feature rather than an A/B test, I would first check whether the pricing data is already available in the application's state or through an API.

That would be cleaner and would remove the need to request the PDP.

The solution also relies on the current basket and PDP markup, so if that structure changes some selectors may need updating.

For a production feature I would also add automated tests around the calculations and the main basket interactions.

## Repo structure

I included two versions to make the test easy to review and run.

    basket-savings_AB-test/
    │
    ├── separated/
    │   ├── experiment.js
    │   └── experiment.css
    │
    ├── standalone/
    │   └── experiment.js
    │
    └── README.md

### `separated/`

This is the cleaner version with the JavaScript and CSS separated.

`experiment.js` contains the experiment logic.

`experiment.css` contains the styling.

### `standalone/`

This version contains everything inside one JavaScript file, including the styles.

I added this mainly to make it quicker to test. It can be copied directly into a JavaScript injection extension without having to add the CSS separately.

## How to test it

I used the User JavaScript and CSS browser extension during development, but the files should also work with another similar injection tool.

### Standalone version

1. Go to CarParts4Less and add some products to the basket.
2. Open the basket.
3. Copy `standalone/experiment.js` into the JavaScript section of the extension.
4. Set it to run on CarParts4Less.
5. Reload the basket.

That's it. The styles are already included in this version.

### Separated version

For the separated version:

1. Add `separated/experiment.js` to the JavaScript section.
2. Add `separated/experiment.css` to the CSS section.
3. Set both to run on CarParts4Less.
4. Reload the basket.

There is no additional setup needed.

## What I tested

I tested the script throughout development with different basket states, including:

* One discounted product
* Multiple discounted products
* Discounted and full price products together
* More than one of the same product
* Changing quantity
* Removing products
* Adding a product from the recommendation carousel
* Applying and removing a voucher
* Product discounts together with voucher savings
* Desktop and mobile layouts

A few of the edge cases only became obvious while testing, especially the duplicate desktop and mobile DOM, the different mobile quantity selector and the way voucher discounts affect Was prices.

I updated the implementation as I found these issues and tested the affected scenarios again.

## Tools

I mainly used Chrome DevTools to inspect the DOM, check selectors, test responsive behaviour and debug what was happening when the basket changed.

I also used ChatGPT during development to help work through some of the JavaScript, debug issues I found while testing and review the final implementation.

The actual testing was done against the live basket, with each change checked in the browser before moving on.




