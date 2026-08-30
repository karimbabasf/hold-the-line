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

/**
 * The agent cannot be cut off, by anyone.
 *
 * Barge-in was on, so Telnyx kept transcribing while the assistant spoke and
 * fed whatever came back in as the caller's turn. On a speakerphone that is
 * the assistant's own voice: the greeting "you've reached the Northvane
 * Mutual claims line" returned as the user message "She reached the North
 * Bay Mutual", and the agent answered its own echo. The greeting is the
 * worst case because it is the longest uninterrupted stretch of TTS on the
 * call, so it gets its own flag.
 *
 * `start_speaking_plan` is carried through unchanged rather than dropped: a
 * PATCH replaces the whole object, and leaving it out resets the endpointing
 * thresholds that decide how fast the agent answers, which is the latency
 * work from earlier in the build.
 */
const NO_INTERRUPTIONS = {
  enable: false,
  disable_greeting_interruption: true,
  start_speaking_plan: {
    wait_seconds: 0.1,
    transcription_endpointing_plan: {
      on_punctuation_seconds: 0.1,
      on_no_punctuation_seconds: 0.1,
      on_number_seconds: 0.1,
    },
    custom_endpointing_rules: null,
  },
  interrupt_prediction_threshold: 0,
} as const;

/** Attacks the same echo one layer lower, on the carrier leg. Off by
 *  default, and a demo on speakerphone in a loud room is exactly the case
 *  it exists for. */
const NOISE_SUPPRESSION = 'deepgram';

/** California is all-party consent and no recorded disclosure exists on this
 *  line. Telnyx defaults recording ON, so this is stated everywhere
 *  `telephony_settings` is written, never left to a default. */
const NO_RECORDING = {
  enabled: false,
  channels: 'dual',
  format: 'mp3',
  stop_on_conversation_end: false,
} as const;
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

/**
 * Registers the bearer token Telnyx presents to our endpoint.
 *
 * This is the same value the server checks as TELEPHONY_SHARED_SECRET, so it
 * comes from the environment. It was briefly a fixed placeholder string in
 * this file, which made the public endpoint effectively unauthenticated to
 * anyone reading the repo.
 */
async function ensureSecret() {
  const token = process.env.TELEPHONY_SHARED_SECRET;
  if (!token) throw new Error('TELEPHONY_SHARED_SECRET is not set');

  const list = await api('GET', '/integration_secrets?page[size]=50');
  const rows = (list['data'] ?? []) as Array<Record<string, unknown>>;
  const existing = rows.find((s) => s['identifier'] === SECRET_ID);
  if (existing) {
    await api('DELETE', `/integration_secrets/${String(existing['id'])}`);
  }
  await api('POST', '/integration_secrets', {
    identifier: SECRET_ID,
    type: 'bearer',
    token,
  });
  console.log(`registered integration secret ${SECRET_ID}`);
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
    greeting: "Hello, you've reached the Northvane Mutual claims line. How can I help you today?",
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
    interruption_settings: NO_INTERRUPTIONS,
    // California is all-party consent and no recorded disclosure exists on
    // this line, so recording stays off. Telnyx defaults it ON.
    telephony_settings: {
      recording_settings: NO_RECORDING,
      noise_suppression: NOISE_SUPPRESSION,
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

/** A URL with the shared secret taken out, for anything that gets printed.
 *  A failed write reports what Telnyx has stored, and what it has stored is
 *  usually a URL of ours carrying a live token. */
const withoutToken = (value: unknown) => String(value).replace(/([?&]k=)[^&]*/g, '$1REDACTED');

/**
 * Points the TeXML application's status callback at us.
 *
 * This is the hangup half, and the only thing that arrives at all when a
 * caller hangs up during silence. Without it the console never learns that
 * an ordinary call ended.
 *
 * It is NOT the wake-up half, which was the original hope for it. On a real
 * call it delivered only `completed`, `conversation_ended` and `analyzed`:
 * everything after the caller had gone. See `pointConversationStart` for
 * what does arrive at the start and why nothing here can.
 *
 * The token rides in the query string because Telnyx sends this callback
 * itself and there is nowhere to configure an Authorization header on it.
 * It is the same shared secret the endpoint already checks, and the URL only
 * ever exists inside this account.
 */
async function pointStatusCallback(assistantId: string, baseUrl: string) {
  const token = process.env.TELEPHONY_SHARED_SECRET;
  if (!token) throw new Error('TELEPHONY_SHARED_SECRET is not set');

  const detail = await api('GET', `/ai/assistants/${assistantId}`);
  const a = (detail['data'] ?? detail) as Record<string, unknown>;
  const telephony = a['telephony_settings'] as Record<string, unknown> | undefined;
  const appId = telephony?.['default_texml_app_id'];
  if (!appId) {
    console.warn('assistant has no default_texml_app_id yet, skipping the status callback');
    return;
  }
  const url =
    `${baseUrl.replace(/\/+$/, '')}/telnyx/status?k=${encodeURIComponent(token)}`;
  // `friendly_name` and `voice_url` go along because the TeXML application
  // update treats them as required and rejects a body without them, even
  // when nothing about them is changing. They are copied off the read rather
  // than reconstructed: this app is created by Telnyx for the assistant, and
  // guessing its voice_url would point the number at nothing.
  const current = await api('GET', `/texml_applications/${String(appId)}`);
  const app = (current['data'] ?? current) as Record<string, unknown>;
  await api('PATCH', `/texml_applications/${String(appId)}`, {
    friendly_name: app['friendly_name'],
    voice_url: app['voice_url'],
    status_callback: url,
    status_callback_method: 'post',
  });

  // Telnyx accepts unknown fields with a 200 and stores nothing, so the write
  // is not evidence. Only the read is.
  const back = await api('GET', `/texml_applications/${String(appId)}`);
  const stored = (back['data'] as Record<string, unknown>)?.['status_callback'];
  if (stored !== url) {
    throw new Error(`status_callback did not stick: ${withoutToken(stored)}`);
  }
  console.log(`status callback -> ${baseUrl.replace(/\/+$/, '')}/telnyx/status`);
}

/**
 * Points the assistant's dynamic-variables webhook at us. This is the wake-up.
 *
 * There is exactly one start-side signal on this integration and this is it.
 * What was tried first, and what each attempt actually returned:
 *
 *   - `status_callback_event` on the TeXML application, the field Twilio uses
 *     to subscribe to initiated/ringing/answered. PATCHed as
 *     `status_callback_event`, `status_callback_events` and
 *     `statusCallbackEvent`: all three returned 200 and NONE came back on the
 *     read. Telnyx's own schema for a TeXML application has no such field, so
 *     that callback fires on one event and it is the end of the call.
 *   - Connection-level call-control webhooks, which would give `call.answered`.
 *     The number's connection IS this TeXML application, and a TeXML
 *     application has no `webhook_event_url`. Nowhere to point them.
 *
 * What works is `dynamic_variables_webhook_url`. Telnyx POSTs it at the start
 * of the conversation to resolve `{{variables}}`:
 *
 *   {"data": {"event_type": "assistant.initialization",
 *             "payload": {"telnyx_end_user_target": "+1...", ...}}}
 *
 * It lands BEFORE the greeting rather than after it, because the greeting is
 * one of the fields those variables get substituted into. That is earlier
 * than an `answered` would have been, and it carries the caller's number.
 *
 * Two consequences worth knowing:
 *
 *   - Telnyx WAITS for the answer, up to
 *     `dynamic_variables_webhook_timeout_ms` (1500), before it speaks. The
 *     handler only touches memory, so it replies at once. The timeout is
 *     left where it is rather than raised: a telephony process that is down
 *     should cost the caller 1.5s of silence and not ten.
 *   - The endpoint has to answer `{"dynamic_variables": {}}` rather than its
 *     usual `{"ok": true}`, or Telnyx records a webhook error against the
 *     conversation. `server.ts` does.
 *
 * Same endpoint and same query-string token as the status callback: Telnyx
 * signs this webhook but sends no Authorization header we can configure.
 */
async function pointConversationStart(assistantId: string, baseUrl: string) {
  const token = process.env.TELEPHONY_SHARED_SECRET;
  if (!token) throw new Error('TELEPHONY_SHARED_SECRET is not set');

  const url = `${baseUrl.replace(/\/+$/, '')}/telnyx/status?k=${encodeURIComponent(token)}`;
  await api('PATCH', `/ai/assistants/${assistantId}`, {
    dynamic_variables_webhook_url: url,
  });

  // Telnyx accepts unknown fields with a 200 and stores nothing, so the write
  // is not evidence. Only the read is.
  const back = await api('GET', `/ai/assistants/${assistantId}`);
  const a = (back['data'] ?? back) as Record<string, unknown>;
  const stored = a['dynamic_variables_webhook_url'];
  if (stored !== url) {
    throw new Error(`dynamic_variables_webhook_url did not stick: ${withoutToken(stored)}`);
  }
  console.log(`conversation start -> ${baseUrl.replace(/\/+$/, '')}/telnyx/status`);
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
  await pointStatusCallback(id, baseUrl);
  await pointConversationStart(id, baseUrl);
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
  // The bearer Telnyx presents to us is registered here too, not only on
  // --create. It is the same value the endpoint checks, so rotating
  // TELEPHONY_SHARED_SECRET without re-registering leaves Telnyx sending the
  // old token: every call reaches the endpoint and is turned away with
  // "rejected an unauthenticated request", which looks exactly like a call
  // that never arrived.
  await ensureSecret();

  // trycloudflare hands out a new hostname on every restart, so this gets run
  // more often than --create does.
  await api('PATCH', `/ai/assistants/${String(ours['id'])}`, {
    greeting: "Hello, you've reached the Northvane Mutual claims line. How can I help you today?",
    model: '',
    external_llm: {
      base_url: `${arg.replace(/\/+$/, '')}/v1`,
      llm_api_key_ref: SECRET_ID,
      model: 'hold-the-line',
    },
    interruption_settings: NO_INTERRUPTIONS,
    // `recording_settings` is restated rather than left to the merge. Telnyx
    // defaults recording ON, this line is in California, and no recorded
    // disclosure exists on it. Sending the surrounding object without it
    // must never be the thing that decides whether the call is recorded.
    telephony_settings: { noise_suppression: NOISE_SUPPRESSION, recording_settings: NO_RECORDING },
  });
  await pointStatusCallback(String(ours['id']), arg);
  await pointConversationStart(String(ours['id']), arg);
  await verify(String(ours['id']));
  console.log(`pointed ${String(ours['id'])} at ${arg}/v1`);
} else {
  console.log('usage: --create <url> | --point <url> | --show');
}
