// Optional notes to Studioflare (a team timeline): when STUDIOFLARE_URL and the secret STUDIOFLARE_API_KEY (a team
// key) are set, alerts that need a person (unanswered refund requests) are also posted there with POST /api/v1/notes.
// Never throws: a failed note is logged, the alert in Revflare stays.

export async function postStudioflareNote(env: Env, body: string): Promise<boolean> {
  if (!env.STUDIOFLARE_URL || !env.STUDIOFLARE_API_KEY || env.TEST_MODE === "true") return false;
  try {
    const res = await fetch(`${env.STUDIOFLARE_URL.replace(/\/+$/, "")}/api/v1/notes`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.STUDIOFLARE_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ body: body.slice(0, 4000), kind: "event", ...(env.STUDIOFLARE_TEAM ? { team: env.STUDIOFLARE_TEAM } : {}) }),
    });
    if (!res.ok) console.error(JSON.stringify({ event: "studioflare_note_failed", status: res.status, body: (await res.text()).slice(0, 300) }));
    return res.ok;
  } catch (err) {
    console.error(JSON.stringify({ event: "studioflare_note_failed", error: String(err) }));
    return false;
  }
}
