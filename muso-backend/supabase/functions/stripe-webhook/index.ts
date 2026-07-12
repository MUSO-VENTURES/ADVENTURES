// POST /stripe-webhook
// Configured in the Stripe dashboard (Developers > Webhooks) to point at
// this function's URL, subscribed to the `checkout.session.completed`
// event. This is the ONLY place Adventure Coins are ever credited from a
// real purchase — buy-coins only ever starts a Checkout Session, it never
// credits anything itself.
//
// Verifies the Stripe-Signature header against STRIPE_WEBHOOK_SECRET before
// trusting the payload, per Stripe's documented scheme:
// https://docs.stripe.com/webhooks#verify-manually
//
// Idempotent by construction: credit_coins() inserts a coin_transactions row
// with the Stripe payment_intent id, and 0007_gamification.sql has a unique
// index on that column, so a retried webhook delivery for the same payment
// fails the insert instead of double-crediting — this function just treats
// that specific failure as a harmless already-processed case.
//
// Requires STRIPE_WEBHOOK_SECRET (from the Stripe dashboard, shown when you
// create the webhook endpoint — starts with whsec_) as an edge function
// secret, alongside STRIPE_SECRET_KEY from buy-coins.

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabaseAdmin.ts";

async function verifyStripeSignature(payload: string, header: string, secret: string): Promise<boolean> {
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k, v];
    }),
  );
  const timestamp = parts["t"];
  const signature = parts["v1"];
  if (!timestamp || !signature) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const expected = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!webhookSecret) {
    return jsonResponse({ error: "STRIPE_WEBHOOK_SECRET is not configured for this project yet." }, 501);
  }

  const signatureHeader = req.headers.get("Stripe-Signature");
  const rawBody = await req.text();

  if (!signatureHeader || !(await verifyStripeSignature(rawBody, signatureHeader, webhookSecret))) {
    return jsonResponse({ error: "Invalid signature" }, 400);
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "Invalid JSON payload" }, 400);
  }

  if (event.type !== "checkout.session.completed") {
    // Not an event we care about — acknowledge so Stripe stops retrying it.
    return jsonResponse({ received: true, ignored: true });
  }

  const session = ((event.data as Record<string, unknown>)?.object ?? {}) as Record<string, unknown>;
  const metadata = (session.metadata ?? {}) as Record<string, unknown>;
  const profileId = metadata.profile_id as string | undefined;
  const coins = Number(metadata.coins);
  const paymentIntentId = (session.payment_intent as string) ?? (session.id as string) ?? null;

  if (!profileId || !Number.isFinite(coins) || coins <= 0) {
    // Malformed metadata shouldn't happen (we set it ourselves in
    // buy-coins), but ack it anyway — retrying won't fix bad metadata.
    return jsonResponse({ received: true, error: "Missing/invalid profile_id or coins in metadata" });
  }

  const admin = getSupabaseAdmin();
  const { error } = await admin.rpc("credit_coins", {
    p_profile_id: profileId,
    p_amount: coins,
    p_reason: "purchase",
    p_stripe_payment_intent_id: paymentIntentId,
  });

  if (error) {
    // Unique-violation on stripe_payment_intent_id means this event was
    // already processed by a prior delivery attempt — that's success, not
    // an error, from Stripe's point of view.
    if (error.code === "23505" || /duplicate key/i.test(error.message)) {
      return jsonResponse({ received: true, alreadyProcessed: true });
    }
    return jsonResponse({ error: error.message }, 500);
  }

  return jsonResponse({ received: true });
});
