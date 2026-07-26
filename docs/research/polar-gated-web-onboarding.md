# Polar constraints for gated Web onboarding

Research date: 2026-07-26. This note records decision-driving constraints for an
authenticated Plakk account that must be paid and have linked storage before entering the normal
Web application. It does not prescribe low-level implementation wiring.

## Answer

Polar can support this onboarding gate without becoming Plakk's identity provider.

The clean product model is a paid recurring Plakk product with a dedicated Polar Feature Flag
benefit representing application access. The authenticated WorkOS user ID can be the Polar
customer's immutable `external_id`. Plakk's backend, not the browser, must decide whether that
specific benefit is currently granted by reading Polar Customer State by external ID. Polar
explicitly recommends Feature Flag benefits for SaaS gating, and Customer State combines active
subscriptions and granted benefits into one authorization-oriented response.
([Feature Flag benefit](https://polar.sh/docs/features/benefits/feature-flags),
[Customer State](https://polar.sh/docs/integrate/customer-state),
[customer external IDs](https://polar.sh/docs/features/customer-management#external-id))

The Web happy path is therefore viable at decision level:

1. Authenticate the Plakk account.
2. If the Plakk access benefit is absent, keep the user in onboarding and start a server-created,
   account-bound Polar checkout.
3. Return to onboarding after checkout and re-read authoritative billing state. The redirect
   itself is not authorization.
4. Once paid access is confirmed, require the existing storage-link flow.
5. Enter the normal Web app only while the backend reports both the access benefit and a connected
   storage provider.

This needs backend enforcement in addition to route-level UI. The current API shape anticipates
`billing` and `storage` blockers, but the backend always returns `canSync: true` with no blockers,
and all product RPCs are protected only by WorkOS authentication. A user could bypass a Web-only
gate and call those RPCs directly.
([current account contract](https://github.com/peterjarian/plakk/blob/db0e819aefb123e5426e23e0ceb5a6e80c17a66e/packages/shared/src/api/PlakkApi.ts#L10-L23),
[current backend status](https://github.com/peterjarian/plakk/blob/db0e819aefb123e5426e23e0ceb5a6e80c17a66e/apps/backend/src/rpcs/PlakkApiLive.ts#L19-L42),
[current protected RPC boundary](https://github.com/peterjarian/plakk/blob/db0e819aefb123e5426e23e0ceb5a6e80c17a66e/packages/shared/src/api/PlakkApi.ts#L139-L206))

## Decision inputs

### Identity and checkout binding

- Polar customer `external_id` is unique within the Polar organization and cannot be changed.
  Polar exposes customer and Customer State endpoints keyed by it, so Plakk does not need a second
  durable account identifier merely for billing.
  ([customer external IDs](https://polar.sh/docs/features/customer-management#external-id),
  [Customer State by external ID](https://polar.sh/docs/api-reference/customers/get-customer-state-by-external-id))
- Checkout creation accepts `external_customer_id`. After successful checkout, Polar creates or
  associates the Customer with that external ID; setting `customer_id` or `external_customer_id`
  also locks the checkout email to that customer. The value must be derived from the authenticated
  session, not accepted as a browser-chosen query value.
  ([Checkout API: External Customer ID](https://polar.sh/docs/features/checkout/session#external-customer-id))
- Plakk already derives its account owner from the verified WorkOS JWT `sub`, and uses that same
  ID for account status, Snippets, and storage. That existing ID is the natural Polar external ID.
  ([backend authentication](https://github.com/peterjarian/plakk/blob/db0e819aefb123e5426e23e0ceb5a6e80c17a66e/apps/backend/src/middleware/AuthMiddlewareLive.ts#L19-L44),
  [account status ownership](https://github.com/peterjarian/plakk/blob/db0e819aefb123e5426e23e0ceb5a6e80c17a66e/apps/backend/src/rpcs/PlakkApiLive.ts#L20-L40))
- Polar has an official TanStack Start adapter for checkout, portal, and webhooks, but its checkout
  handler accepts customer identifiers as query parameters. That convenience surface does not by
  itself bind checkout to WorkOS; Plakk still has to derive the customer identity on a trusted
  server boundary.
  ([Polar TanStack Start adapter](https://polar.sh/docs/integrate/sdk/adapters/tanstack-start))

### Product and entitlement model

- Products can be one-time or recurring. A subscription is created when a customer checks out a
  product with recurring pricing. A Feature Flag benefit is granted for subscription access and
  is available in Customer State; for a one-time purchase the flag is lifetime access. The
  existing “Plakk Pro / Current plan” surface and recoverable recurring billing semantics therefore
  align with a recurring product rather than a one-time product.
  ([subscriptions](https://polar.sh/docs/features/subscriptions/introduction),
  [Feature Flag lifecycle](https://polar.sh/docs/features/benefits/feature-flags#lifecycle),
  [current Plakk billing surface](https://github.com/peterjarian/plakk/blob/db0e819aefb123e5426e23e0ceb5a6e80c17a66e/apps/desktop/src/renderer/views/Settings.tsx#L167-L182))
- Gate on the dedicated benefit, not merely on the presence of any subscription or any Polar
  customer. Customer State is specifically intended to answer whether access should be
  provisioned and includes only active subscriptions and granted benefits.
  ([Customer State](https://polar.sh/docs/integrate/customer-state))
- “Paid” needs one product-policy choice before the onboarding spec is complete. Trialing
  subscriptions retain benefits, so a benefit-only gate admits trials. If Plakk means literally
  charged customers only, the product must have no trial or the gate must distinguish trialing
  from paid state.
  ([subscription benefit lifecycle](https://polar.sh/docs/features/subscriptions/introduction#how-subscriptions-work),
  [subscription trials](https://polar.sh/docs/features/subscriptions/trials))

### Checkout return and authoritative state

- Polar can substitute `{CHECKOUT_ID}` into the checkout success URL. That ID is useful for
  confirmation, but it is not itself an entitlement. Polar's integration guide notes that a
  returned checkout can first be `confirmed` and is not successful until processing reaches
  `succeeded`.
  ([Checkout success URL](https://polar.sh/docs/features/checkout/links#success-url),
  [Polar checkout confirmation guidance](https://polar.sh/docs/guides/laravel#creating-the-confirmation-page))
- The onboarding return must therefore remain a gated “confirming payment” state until the
  authenticated account's Customer State contains the expected access benefit. Refreshing,
  replaying, or fabricating a success URL cannot grant access.
- If Polar cannot be checked, the safe behavior is to keep the account out of the normal app while
  offering retry and billing recovery. Treating an unavailable billing check as paid would defeat
  the requested gate.

### Ongoing subscription state

- Cancel-at-period-end leaves a subscription active and keeps its benefits through the paid
  period. Immediate revocation cancels it and revokes benefits immediately.
  ([subscription cancellation](https://polar.sh/docs/features/subscriptions/introduction#cancellation),
  [cancellation event sequence](https://polar.sh/docs/integrate/webhooks/events#cancellation-sequences))
- A failed renewal moves the subscription to `past_due`. Polar retries over as long as 21 days.
  Benefit revocation is immediate by default, but the organization can configure a 2, 7, 14, or
  21-day grace period during which the benefit remains granted. Therefore the Feature Flag grant,
  not the raw `past_due` label, is the consistent access signal; choosing a grace period is still a
  product-policy decision for this map.
  ([failed-payment recovery and benefit grace](https://polar.sh/docs/features/subscriptions/failed-payments))
- Once retries are exhausted or a subscription is revoked, Polar revokes benefits. Customer State
  then removes the access grant, so the same gate can cover onboarding, cancellation, failed
  payment, and later re-entry without inventing a separate entitlement model.
  ([failed-payment recovery](https://polar.sh/docs/features/subscriptions/failed-payments),
  [Customer State](https://polar.sh/docs/integrate/customer-state))

### Webhooks are synchronization, not the sole gate

- `customer.state_changed` is triggered for customer changes, subscription changes, and benefit
  grant or revocation. It is the broad event Polar recommends for keeping application access
  synchronized.
  ([Customer State webhook](https://polar.sh/docs/integrate/customer-state#the-customerstate_changed-webhook))
- Webhook delivery is asynchronous and fallible: Polar retries failed deliveries up to ten times,
  uses delivery timeouts, and automatically disables an endpoint after ten consecutive failed
  deliveries. Polar also supports inspecting and manually redelivering historical deliveries.
  The gate cannot rely on a webhook having arrived before the user returns from checkout.
  ([webhook failure handling](https://polar.sh/docs/integrate/webhooks/delivery#failure-handling))
- Decision-level consequence: use signed `customer.state_changed` events to keep local authorization
  state fresh, but reconcile from Customer State on checkout return and whenever a definitive gate
  decision is needed. This avoids both delayed admission after payment and stale access after
  webhook failure.

### Portal and secret ownership

- Polar's hosted Customer Portal supports subscription cancellation, invoices, receipts, and
  payment-method updates. Payment-method update is the primary failed-payment recovery path and is
  not fully replaceable with the custom Customer Portal API.
  ([Customer Portal](https://polar.sh/docs/features/customer-portal/introduction))
- A signed-in Plakk user can be sent through a short-lived, pre-authenticated portal URL created by
  a server-side Customer Session. The URL should be generated when clicked, not stored.
  ([pre-authenticated portal links](https://polar.sh/docs/features/customer-portal/navigate-customers#pre-authenticated-portal-links),
  [Create Customer Session](https://polar.sh/docs/api-reference/customer-sessions/create-customer-session))
- Polar Organization Access Tokens authorize organization-level checkout, customer, subscription,
  and benefit operations and must never be exposed in client code. Customer Sessions are created
  server-side. Webhook requests must be signature-verified with a separate webhook secret.
  ([Polar authentication](https://polar.sh/docs/integrate/authentication),
  [API authentication boundary](https://polar.sh/docs/api-reference/introduction#authentication),
  [webhook validation](https://polar.sh/docs/integrate/webhooks/delivery#validate--parse-webhooks))

### Existing Plakk behavior that the plan must change deliberately

- The shared contract already models both `billing` and `storage` as account blockers and considers
  sync available only when no blocker exists and a provider is linked. This is the right
  cross-client product boundary to extend rather than creating a Web-only billing state.
  ([account capability contract](https://github.com/peterjarian/plakk/blob/db0e819aefb123e5426e23e0ceb5a6e80c17a66e/packages/shared/src/api/PlakkApi.ts#L10-L23),
  [storage connection composition](https://github.com/peterjarian/plakk/blob/db0e819aefb123e5426e23e0ceb5a6e80c17a66e/packages/shared/src/api/PlakkApi.ts#L48-L51))
- Today, however, billing is presentation-only scaffolding: Desktop knows how to display “finish
  billing” and “sync paused,” while the backend never reports a billing blocker. No current
  server-side authorization prevents a signed-in, unpaid caller from invoking Snippet RPCs.
  ([Desktop paused message](https://github.com/peterjarian/plakk/blob/db0e819aefb123e5426e23e0ceb5a6e80c17a66e/apps/desktop/src/renderer/views/Home.tsx#L77-L87),
  [backend placeholder status](https://github.com/peterjarian/plakk/blob/db0e819aefb123e5426e23e0ceb5a6e80c17a66e/apps/backend/src/rpcs/PlakkApiLive.ts#L19-L42),
  [authentication-only RPC group](https://github.com/peterjarian/plakk/blob/db0e819aefb123e5426e23e0ceb5a6e80c17a66e/packages/shared/src/api/PlakkApi.ts#L204-L206))
- A hard Web onboarding gate is stricter than current Desktop presentation, which still renders
  Home and pauses adding/sync. The map should record this as an intentional Web onboarding policy
  and separately preserve consistent backend authorization for every client.

## Resulting direction

Use the WorkOS user ID as Polar `external_id`; sell a recurring Plakk product with a dedicated
access Feature Flag; have the backend derive checkout identity, hold Polar secrets, verify
webhooks, and answer the combined billing/storage capability; and let Web own the onboarding
presentation and redirects. Do not admit the account because it reached a checkout success URL.
Admit it only after an authoritative Customer State read confirms the expected benefit and the
existing storage contract confirms a connected provider.

Two product choices remain for a later decision ticket: whether trials count as “paid,” and whether
`past_due` customers receive Polar's configurable benefit grace period.
