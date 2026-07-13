// GET /route-detail?routeId=...
//
// Returns a route and its ordered stops for the itinerary reveal UI.
// Mystery stops (is_mystery = true) have their name/description masked
// until check-in, mirroring the "Unknown Location" behavior on the
// landing page demo.
//
// Free-tier stop cap (0011_stop_unlock.sql): every player's
// unlocked_stop_count defaults to 3. Stops beyond that (stop_order >
// unlockedStopCount) are withheld entirely from the `stops` array rather
// than sent-but-masked, so there's nothing in the response for a client to
// bypass the paywall with. The response's `unlockedStopCount`/`totalStops`/
// `locked` fields let the client render an honest "N more stops available"
// teaser and drive the unlock-feature('extra_stops') CTA.

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getSupabaseAsUser } from "../_shared/supabaseAdmin.ts";

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const url = new URL(req.url);
  const routeId = url.searchParams.get("routeId");
  if (!routeId) {
    return jsonResponse({ error: "routeId is required" }, 400);
  }

  let client;
  try {
    client = getSupabaseAsUser(req);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  const { data: route, error: routeErr } = await client
    .from("routes")
    .select("id, title, description, twist_key, stop_count_options, is_sponsored")
    .eq("id", routeId)
    .single();

  if (routeErr || !route) {
    return jsonResponse({ error: routeErr?.message ?? "Route not found" }, 404);
  }

  const { data: stops, error: stopsErr } = await client
    .from("route_stops")
    .select("id, stop_order, name, description, emoji, is_mystery")
    .eq("route_id", routeId)
    .order("stop_order", { ascending: true });

  if (stopsErr) {
    return jsonResponse({ error: stopsErr.message }, 400);
  }

  // Self-row read, already allowed by the existing profiles RLS policy for
  // the authenticated caller — no service role needed here.
  const { data: userData } = await client.auth.getUser();
  const userId = userData?.user?.id;

  let unlockedStopCount = 3;
  if (userId) {
    const { data: profile } = await client
      .from("profiles")
      .select("unlocked_stop_count")
      .eq("id", userId)
      .maybeSingle();
    unlockedStopCount = profile?.unlocked_stop_count ?? 3;
  }

  const totalStops = (stops ?? []).length;
  const visibleStops = (stops ?? []).filter((s) => (s.stop_order as number) <= unlockedStopCount);

  const itinerary = visibleStops.map((s: Record<string, unknown>) =>
    s.is_mystery
      ? { ...s, name: "Unknown Location", description: "We pick. You don't find out until you arrive." }
      : s,
  );

  return jsonResponse({
    route,
    stops: itinerary,
    unlockedStopCount,
    totalStops,
    locked: totalStops > unlockedStopCount,
  });
});
