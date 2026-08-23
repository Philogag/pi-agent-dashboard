/**
 * One-shot Matrix notice over plain REST (global fetch) — deliberately NOT
 * matrix-bot-sdk: its legacy `request`-era dependency tree loads poorly under
 * pnpm's strict hoisting in the dashboard monorepo, and the notice needs only
 * two client-server API calls (create a direct room, send a message).
 *
 * Strictly best-effort: any failure returns false and is logged by the caller.
 *
 * Used by the connect controller to DM the paired trusted users that the bridge
 * came up (the RPC-pushed init prompt produces no transport-attributed reply,
 * so the standard pi→matrix forward path stays silent — see design D7).
 */
export async function notifyMatrixUser(opts: {
  homeserverUrl: string;
  accessToken: string;
  /** @user:server (with or without the `matrix:` transport prefix) */
  userId: string;
  text: string;
}): Promise<boolean> {
  const userId = opts.userId.startsWith("matrix:") ? opts.userId.slice("matrix:".length) : opts.userId;
  const base = opts.homeserverUrl.replace(/\/+$/, "");
  const headers = {
    Authorization: `Bearer ${opts.accessToken}`,
    "Content-Type": "application/json",
  };
  try {
    const createRes = await fetch(`${base}/_matrix/client/v3/createRoom`, {
      method: "POST",
      headers,
      body: JSON.stringify({ preset: "trusted_private_chat", invite: [userId], is_direct: true }),
    });
    if (!createRes.ok) return false;
    const { room_id: roomId } = (await createRes.json()) as { room_id?: string };
    if (!roomId) return false;

    const sendRes = await fetch(
      `${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message`,
      { method: "POST", headers, body: JSON.stringify({ msgtype: "m.text", body: opts.text }) },
    );
    return sendRes.ok;
  } catch {
    return false;
  }
}