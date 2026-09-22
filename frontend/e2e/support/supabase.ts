/**
 * Read-only access to the `messages` table through Supabase's REST API
 * (PostgREST), for database-level checks in the end-to-end specs: roles,
 * conversation_name, tool_calls and the needs_attention / read transitions.
 *
 * SUPABASE_URL / SUPABASE_KEY come from the environment or the repo's .env and
 * are never logged. Only SELECTs are issued: this helper never writes or
 * deletes (test threads are cleaned up separately).
 */
import { envValue } from './env';

export interface DbRow {
  id: number;
  conversation_id: string;
  conversation_name: string | null;
  role: 'visitor' | 'avatar' | 'human';
  content: string;
  tool_calls: any[] | null;
  needs_attention: boolean;
  read: boolean;
  created_at: string;
}

function restBase(): { url: string; key: string } {
  const url = envValue('SUPABASE_URL').replace(/\/+$/, '');
  const key = envValue('SUPABASE_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_KEY are not set (env or ../.env)');
  return { url, key };
}

/** Every row of one conversation, oldest first (straight from the database). */
export async function dbRows(conversationId: string): Promise<DbRow[]> {
  if (!/^[0-9a-f-]{36}$/i.test(conversationId)) throw new Error('not a conversation id');
  const { url, key } = restBase();
  const res = await fetch(
    `${url}/rest/v1/messages?conversation_id=eq.${conversationId}&select=*&order=created_at.asc,id.asc`,
    { headers: { apikey: key, Accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`Supabase select -> HTTP ${res.status}`);
  return (await res.json()) as DbRow[];
}

/** Names of the tools recorded on a row (`instant` for a Qn shortcut). */
export function toolNames(row: DbRow): string[] {
  return (row.tool_calls ?? []).map((c: any) => (c.type === 'instant' ? 'instant' : String(c.name)));
}

/** A compact, loggable view of a conversation's rows (no message bodies). */
export function rowSummary(rows: DbRow[]): string[] {
  return rows.map((r) => {
    const tools = toolNames(r);
    return `${r.id} ${r.role}${tools.length ? ` [${tools.join(',')}]` : ''} read=${r.read} attention=${r.needs_attention}`
      + `${r.conversation_name ? ` name="${r.conversation_name}"` : ''}`;
  });
}
