# Domain Context

## Billing

### Free Period

Plakk-owned, card-free access that ends at a deadline carried in the user's signed identity
token.

Avoid calling this a trial. A Polar Trial is a different concept and collects a payment method
up front.

### Polar Trial

A trial attached to a Polar subscription. Polar Checkout collects a payment method before this
trial begins.

### Customer State

Polar's complete, authoritative view of a customer, including active subscriptions and benefits.
Plakk may cache this state, but does not copy it into its database or treat the cache as a second
source of truth.

### Plakk Access

The Polar Feature Flag benefit attached to every paid Plakk product. Its active grant is the
paid-access entitlement; product IDs only identify the monthly and yearly choices at checkout.

### Payment Required

The access state of a user who has neither the Plakk Access benefit nor an unexpired Free Period.
