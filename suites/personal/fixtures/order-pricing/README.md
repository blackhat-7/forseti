# Garden shop orders

Prices orders for a small garden-supplies shop, issues invoices and pays refunds.
Everything is in memory; `app.Shop` wires the pieces together. Money is whole cents.

| Module | Role |
|---|---|
| `app.py` | Public entry points: place_order, invoice, refund, set_price, end_promotion |
| `checkout.py` | Prices a cart and records the order |
| `cart.py` | Turns cart entries into invoice lines |
| `price_cache.py` | Tier price lists, rebuilt when the catalog changes |
| `pricing.py` | Tier price of one product |
| `promotions.py` | Percentage and multi-buy promotions |
| `invoice.py` | Line and order totals |
| `tax.py` | VAT by product category |
| `shipping.py` | Delivery charge |
| `refunds.py` | Refunds against a placed order |
| `orders.py` | Order book |
| `catalog.py` | Products and list prices |
| `customers.py` | Customers and their price tiers |
| `money.py` | Rounding and formatting |
| `errors.py` | Exceptions callers can catch |

Prices in the catalog are list prices without VAT. A customer's tier sets the price they pay
before promotions. VAT is added per invoice line.
