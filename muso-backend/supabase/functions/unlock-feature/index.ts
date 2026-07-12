// POST /unlock-feature
// Body: { feature: 'venue_search' | 'radius' }
// Requires Authorization: Bearer <user JWT> (Supabase Auth).
//
// 'venue_search' — unlocks real results from venues-search. Free once the
// caller's profile reaches Level 5 (xp >= 400); otherwise costs
// VENUE_SEARCH_COST Adventure Coins. Permanent once unlocked.
//
// 'radius' — raises the caller's unlocked_radius_miles from the free 25mi
// default up to RADIUS_UNLOCK_MILES. Coins-only, no level path. Permanent
// once unlocked (re-running it when already at/above the target is a no-op
// success, not an error).
//
// All balance changes go through debit_coins()/direct profile updates via
// the service role, which is the only role allowed to touch these columns
// (see the `revoke update (...)` in 0007_gamification.sql) — so this
// function is the single, auditable code path that can ever move a
// player's coin balance or unlock flags.

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabaseAdmin.ts";

const UNLOCK_LEVEL = 5; // xp >= 400
const VENUE_SEARCH_COST = 250;
const RADIUS_UNLOCK_COST = 150;
const RADIUS_UNLOCK_MILES = 100;

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) {
    return jsonResponse({ error: "Sign in to unlock this." }, 401);
  }

  const admin = getSupabaseAdmin();
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const userId = userData?.user?.id;
  if (userErr || !userId) {
    return jsonResponse({ error: "Your session has expired — sign in again." }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const feature = body.feature;
  if (feature !== "venue_search" && feature !== "radius") {
    return jsonResponse({ error: "feature must be 'venue_search' or 'radius'" }, 400);
  }

  const { data: profile, error: profileErr } = await admin
    .from("profiles")
    .select("level, adventure_coins, unlocked_radius_miles, venues_search_unlocked")
    .eq("id", userId)
    .maybeSingle();

  if (profileErr || !profile) {
    return jsonResponse({ error: "Couldn't load your profile." }, 400);
  }

  if (feature === "venue_search") {
    if (profile.venues_search_unlocked) {
      return jsonResponse({ ok: true, alreadyUnlocked: true, unlocked: true });
    }

    if ((profile.level ?? 1) >= UNLOCK_LEVEL) {
      const { error } = await admin
        .from("profiles")
        .update({ venues_search_unlocked: true })
        .eq("id", userId);
      if (error) return jsonResponse({ error: error.message }, 400);
      return jsonResponse({ ok: true, unlocked: true, method: "level" });
    }

    const { data: success, error } = await admin.rpc("debit_coins", {
      p_profile_id: userId,
      p_amount: VENUE_SEARCH_COST,
      p_reason: "unlock_venue_search",
    });
    if (error) return jsonResponse({ error: error.message }, 400);
    if (!success) {
      return jsonResponse(
        {
          error: `Not enough Adventure Coins. Need ${VENUE_SEARCH_COST}, you have ${profile.adventure_coins}. Reach Level ${UNLOCK_LEVEL} to unlock for free instead.`,
        },
        402,
      );
    }

    const { error: flagErr } = await admin
      .from("profiles")
      .update({ venues_search_unlocked: true })
      .eq("id", userId);
    if (flagErr) return jsonResponse({ error: flagErr.message }, 400);

    return jsonResponse({ ok: true, unlocked: true, method: "coins", spent: VENUE_SEARCH_COST });
  }

  // feature === "radius"
  if ((profile.unlocked_radius_miles ?? 25) >= RADIUS_UNLOCK_MILES) {
    return jsonResponse({
      ok: true,
      alreadyUnlocked: true,
      unlockedRadiusMiles: profile.unlocked_radius_miles,
    });
  }

  const { data: success, error } = await admin.rpc("debit_coins", {
    p_profile_id: userId,
    p_amount: RADIUS_UNLOCK_COST,
    p_reason: "unlock_radius",
  });
  if (error) return jsonResponse({ error: error.message }, 400);
  if (!success) {
    return jsonResponse(
      {
        error: `Not enough Adventure Coins. Need ${RADIUS_UNLOCK_COST}, you have ${profile.adventure_coins}.`,
      },
      402,
    );
  }

  const { error: radiusErr } = await admin
    .from("profiles")
    .update({ unlocked_radius_miles: RADIUS_UNLOCK_MILES })
    .eq("id", userId);
  if (radiusErr) return jsonResponse({ error: radiusErr.message }, 400);

  return jsonResponse({
    ok: true,
    unlockedRadiusMiles: RADIUS_UNLOCK_MILES,
    spent: RADIUS_UNLOCK_COST,
  });
});
