# ADR 0008: Read Polar customer state on demand

Status: Accepted

Plakk will treat Polar as the source of truth for paid access and will not mirror billing state
into Postgres, consume billing webhooks, or run a reconciliation poller. The backend reads the
full Polar Customer State by the WorkOS user ID used as `external_customer_id`, caching both
found and not-found results in Redis for five minutes through Effect Persistence. Starting a
checkout invalidates that entry and creates a short-lived pending marker; subsequent account
requests periodically bypass the cached value until Polar reports the subscription, so closing
the checkout tab cannot strand a successful payment. Checkout success also returns to Plakk and
therefore triggers the same refresh path.

Paid access is granted by one Polar Feature Flag benefit attached to every eligible product.
Authorization checks that benefit grant rather than product IDs, keeping entitlement policy
independent of the monthly and yearly products offered at checkout.

The tradeoff is bounded staleness of up to five minutes for changes made outside Plakk. This is
accepted in exchange for avoiding a second durable billing model and the distributed-system
failure modes needed to synchronize it. Plakk's card-free Free Period remains separate from
Polar and is derived from a signed WorkOS JWT claim.
