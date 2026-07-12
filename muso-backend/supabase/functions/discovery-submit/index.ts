// POST /discovery-submit
// Body matches the landing page's Quick/Full discovery form:
// { partyId?, mode, budget, contentRating, alcoholPref, interests?, occasion?, groupSize?, notes? }
//
// Open to unauthenticated visitors too (a planner might fill this out before
// creating an account), so it uses the admin client but validates the shape
// tightly rather than relying on RLS to catch bad input.

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabaseAdmin.ts";

const VALID_BUDGETS = ["$", "$$", "$$$", "$$$$"];
const VALID_RATINGS = ["G-Rated", "PG-Rated", "NC-17", "Adults Only"];
const VALID_ALCOHOL = ["Alcohol-Friendly", "Sober / Alcohol-Free"];

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const mode = body.mode === "full" ? "full" : "quick";

  if (body.budget && !VALID_BUDGETS.includes(body.budget as string)) {
    return jsonResponse({ error: "Invalid budget value" }, 400);
  }
  if (body.contentRating && !VALID_RATINGS.includes(body.contentRating as string)) {
    return jsonResponse({ error: "Invalid contentRating value" }, 400);
  }
  if (body.alcoholPref && !VALID_ALCOHOL.includes(body.alcoholPref as string)) {
    return jsonResponse({ error: "Invalid alcoholPref value" }, 400);
  }

  const admin = getSupabaseAdmin();

  const { data, error } = await admin
    .from("discovery_responses")
    .insert({
      party_id: body.partyId ?? null,
      mode,
      budget: body.budget ?? null,
      content_rating: body.contentRating ?? null,
      alcohol_pref: body.alcoholPref ?? null,
      interests: Array.isArray(body.interests) ? body.interests : null,
      occasion: body.occasion ?? null,
      group_size: body.groupSize ? Number(body.groupSize) : null,
      notes: typeof body.notes === "string" ? body.notes.slice(0, 2000) : null,
    })
    .select()
    .single();

  if (error) {
    return jsonResponse({ error: error.message }, 400);
  }

  return jsonResponse({ discoveryResponse: data }, 201);
});
