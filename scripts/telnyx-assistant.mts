/**
 * Creates and points the Telnyx AI Assistant at our endpoint.
 *
 * Telnyx Assistant owns speech to text, text to speech and turn taking, and
 * drives all of it by calling an external LLM over the OpenAI chat protocol.
 * So the whole telephony integration is: create an assistant, set its
 * api_base_url to our tunnel, assign the number. No media bridge.
 *
 * Usage:
 *   node --env-file=.env.local scripts/telnyx-assistant.mts --create
 *   node --env-file=.env.local scripts/telnyx-assistant.mts --point https://x.trycloudflare.com
 *   node --env-file=.env.local scripts/telnyx-assistant.mts --show
 *
 * Never touches the two Pakkr assistants. It refuses to operate on any
 * assistant whose name it did not create.
 */

const API = 'https://api.telnyx.com/v2';
const ASSISTANT_NAME = 'hold-the-line (hackathon)';
const SECRET_ID = 'hold_the_line_llm';

/** Mirrors the config proven on a live line. Voice is chosen by ear, never
 *  by reasoning, so it is pinned here rather than selected. */
const VOICE = 'Telnyx.Ultra.f786b574-daa5-4673-aa0c-cbe3e8534c02';
const TRANSCRIPTION_MODEL = 'deepgram/flux';

const key = process.env.TELNYX_API_KEY;
if (!key) {
  console.error('TELNYX_API_KEY is not set. Run with --env-file=.env.local');
  process.exit(1);
}
const H = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: H,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json as Record<string, unknown>;
}

async function findOurs() {
  const list = await api('GET', '/ai/assistants');
  const rows = (list['data'] ?? list['assistants'] ?? []) as Array<Record<string, unknown>>;
  return rows.find((a) => a['name'] === ASSISTANT_NAME) ?? null;
}

/** Telnyx requires an api_key_ref even when the endpoint does not check it,
 *  so a placeholder secret is registered once. */
async function ensureSecret() {
  const list = await api('GET', '/integration_secrets?page[size]=50');
  const rows = (list['data'] ?? []) as Array<Record<string, unknown>>;
  if (rows.some((s) => s['identifier'] === SECRET_ID)) return;
  await api('POST', '/integration_secrets', {
    identifier: SECRET_ID,
    type: 'bearer',
    token: 'unused-local-endpoint-does-not-authenticate',
  });
  console.log(`created integration secret ${SECRET_ID}`);
}

/**
 * Three things here were learned the expensive way and are load-bearing.
 *
 * 1. The field is `external_llm`, NOT `api_base_url`. Telnyx accepts
 *    api_base_url with a 200 and silently stores nothing.
 * 2. `model` and `external_llm` are mutually exclusive, and clearing model
 *    needs `""`. Sending `null` returns "cannot have both" even though the
 *    intent is obviously to clear it.
 * 3. `llm_api_key_ref` is the integration secret's IDENTIFIER string, not its
 *    UUID. Passing the UUID gives "not found", which reads like the secret is
 *    missing when it exists.
 *
 * Telnyx appends `/chat/completions` to base_url itself, so base_url ends
 * at `/v1`.
 */
function manifest(baseUrl: string) {
  return {
    name: ASSISTANT_NAME,
    model: '',
    external_llm: {
      base_url: `${baseUrl.replace(/\/+$/, '')}/v1`,
      llm_api_key_ref: SECRET_ID,
      model: 'hold-the-line',
    },
    instructions:
      'Relay only. Every decision comes from the endpoint you are calling. Speak exactly what it returns.',
    enabled_features: ['telephony'],
    voice_settings: { voice: VOICE, voice_speed: 1 },
    transcription: { model: TRANSCRIPTION_MODEL, language: 'en' },
    // California is all-party consent and no recorded disclosure exists on
    // this line, so recording stays off. Telnyx defaults it ON.
    telephony_settings: {
      recording_settings: { enabled: false, channels: 'dual', format: 'mp3', stop_on_conversation_end: false },
    },
  };
}

/**
 * A number reaches an assistant through the TeXML app Telnyx auto-creates for
 * it, not through any /ai/assistants/{id}/phone_numbers route. That route
 * 404s.
 */
async function assignNumber(assistantId: string) {
  const number = process.env.TELNYX_NUMBER;
  if (!number) {
    console.log('TELNYX_NUMBER not set, skipping number assignment');
    return;
  }
  const detail = await api('GET', `/ai/assistants/${assistantId}`);
  const a = (detail['data'] ?? detail) as Record<string, unknown>;
  const telephony = a['telephony_settings'] as Record<string, unknown> | undefined;
  const texmlAppId = telephony?.['default_texml_app_id'];
  if (!texmlAppId) throw new Error('assistant has no default_texml_app_id yet');

  const list = await api('GET', `/phone_numbers?filter[phone_number]=${encodeURIComponent(number)}`);
  const rows = (list['data'] ?? []) as Array<Record<string, unknown>>;
  const numberId = rows[0]?.['id'];
  if (!numberId) throw new Error(`${number} is not on this account`);

  await api('PATCH', `/phone_numbers/${String(numberId)}`, { connection_id: texmlAppId });
  console.log(`assigned ${number} via texml app ${String(texmlAppId)}`);
}

/**
 * Reads back what Telnyx actually stored.
 *
 * Telnyx accepts unknown fields with a 200 and stores nothing, so a write is
 * not evidence. Only the read is.
 */
async function verify(assistantId: string) {
  const detail = await api('GET', `/ai/assistants/${assistantId}`);
  const a = (detail['data'] ?? detail) as Record<string, unknown>;
  const llm = a['external_llm'] as Record<string, unknown> | null;
  if (!llm?.['base_url']) throw new Error('external_llm was not stored, the assistant will not call us');
  console.log('verified base_url:', String(llm['base_url']));
}

const [flag, arg] = process.argv.slice(2);

if (flag === '--show') {
  const ours = await findOurs();
  console.log(ours ? JSON.stringify({ id: ours['id'], name: ours['name'], api_base_url: ours['api_base_url'] }, null, 1) : 'not created yet');
} else if (flag === '--create') {
  if (await findOurs()) {
    console.error('already exists. use --point to change its URL.');
    process.exit(1);
  }
  const baseUrl = arg ?? process.env.PUBLIC_BASE_URL;
  if (!baseUrl) {
    console.error('pass the public URL: --create https://x.trycloudflare.com');
    process.exit(1);
  }
  await ensureSecret();
  const created = await api('POST', '/ai/assistants', manifest(baseUrl));
  const id = String((created['data'] as Record<string, unknown>)?.['id'] ?? created['id']);
  console.log(`created assistant ${id}`);
  await assignNumber(id);
  await verify(id);
} else if (flag === '--point') {
  const ours = await findOurs();
  if (!ours) {
    console.error('not created yet. run --create first.');
    process.exit(1);
  }
  if (!arg) {
    console.error('pass the new public URL');
    process.exit(1);
  }
  // trycloudflare hands out a new hostname on every restart, so this gets run
  // more often than --create does.
  await api('PATCH', `/ai/assistants/${String(ours['id'])}`, {
    model: '',
    external_llm: {
      base_url: `${arg.replace(/\/+$/, '')}/v1`,
      llm_api_key_ref: SECRET_ID,
      model: 'hold-the-line',
    },
  });
  await verify(String(ours['id']));
  console.log(`pointed ${String(ours['id'])} at ${arg}/v1`);
} else {
  console.log('usage: --create <url> | --point <url> | --show');
}
