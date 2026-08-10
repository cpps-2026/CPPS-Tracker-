/* CPPS Tracker — presence, live refresh, and conflict-safe saves
 *
 * Schema this expects:
 *   tracker_kv(key text primary key, value jsonb, version bigint default 1)
 *   rows: 'opportunities' | 'planTargets' | 'teamLists'
 *
 * Load order:
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *   <script src="presence-realtime.js"></script>
 *
 * Start:
 *   Presence.start({ onData: applyRows, people: TEAM_NAMES, page: 'Overview' });
 *
 * Save one record (replaces your current whole-blob write):
 *   await Presence.saveRecord(rec);
 */

const Presence = (() => {

  const SUPABASE_URL = 'https://eggszukiqudidbpdghkh.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_wyHJ-ll0wAskXbJYiWjWLg_4kw4hT4O';

  const TABLE   = 'tracker_kv';
  const KEY     = 'opportunities';
  const ID      = 'id';          // the field that uniquely identifies a record
  const RETRIES = 4;

  let client = null;
  let channel = null;
  let me = null;
  let onData = null;
  let isEditing = false;
  let missed = false;
  let localVersion = 0;
  let debounce = null;

  /* ---------------------------------------------------------------
   * Reading
   * ------------------------------------------------------------- */

  async function load() {
    const { data, error } = await client
      .from(TABLE).select('value, version').eq('key', KEY).single();
    if (error) throw error;
    return { rows: data.value || [], version: data.version };
  }

  async function refresh() {
    if (isEditing) { missed = true; return; }
    try {
      const { rows, version } = await load();
      localVersion = version;
      if (typeof onData === 'function') onData(rows);
      missed = false;
    } catch (err) {
      console.warn('[tracker] refresh failed', err);
    }
  }

  function scheduleRefresh() {
    clearTimeout(debounce);
    debounce = setTimeout(refresh, 300);
  }

  /* ---------------------------------------------------------------
   * Writing — compare-and-swap with automatic per-record merge
   *
   * The write only lands if the version still matches what we read.
   * If someone else saved in between, we reload their blob, re-apply
   * just this record on top, and try again. Their edit survives and
   * so does ours.
   * ------------------------------------------------------------- */

  async function saveRecord(record) {
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const { rows, version } = await load();

      const next = rows.slice();
      const i = next.findIndex(r => r[ID] === record[ID]);
      if (i >= 0) next[i] = record; else next.push(record);

      const { data, error } = await client
        .from(TABLE)
        .update({ value: next, version: version + 1 })
        .eq('key', KEY)
        .eq('version', version)      // the guard: fails if someone beat us
        .select('version');

      if (error) throw error;

      if (data && data.length) {
        localVersion = data[0].version;
        if (typeof onData === 'function') onData(next);
        return next;
      }

      await new Promise(r => setTimeout(r, 120 * (attempt + 1)));
    }

    throw new Error('Could not save — the tracker is being edited heavily. Try again.');
  }

  async function deleteRecord(recordId) {
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const { rows, version } = await load();
      const next = rows.filter(r => r[ID] !== recordId);

      const { data, error } = await client
        .from(TABLE)
        .update({ value: next, version: version + 1 })
        .eq('key', KEY).eq('version', version).select('version');

      if (error) throw error;
      if (data && data.length) {
        localVersion = data[0].version;
        if (typeof onData === 'function') onData(next);
        return next;
      }
      await new Promise(r => setTimeout(r, 120 * (attempt + 1)));
    }
    throw new Error('Could not delete — try again.');
  }

  /* ---------------------------------------------------------------
   * Identity
   * ------------------------------------------------------------- */

  function identify(names) {
    const saved = localStorage.getItem('cpps_name');
    if (saved) return saved;

    let name;
    if (names && names.length) {
      const list = names.map((n, i) => `${i + 1}. ${n}`).join('\n');
      const pick = window.prompt(`Who's using the tracker?\n\n${list}\n\nEnter a number or type your name:`);
      const idx = parseInt(pick, 10);
      name = Number.isInteger(idx) && names[idx - 1] ? names[idx - 1] : pick;
    } else {
      name = window.prompt('Your name (so the team can see who\'s in the tracker):');
    }

    name = (name || 'Guest').trim();
    localStorage.setItem('cpps_name', name);
    return name;
  }

  /* ---------------------------------------------------------------
   * Avatar bar
   * ------------------------------------------------------------- */

  const initials = n => n.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();

  const tint = n => {
    let h = 0;
    for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h} 45% 42%)`;
  };

  function mount() {
    if (document.getElementById('cpps-presence')) return;
    const bar = document.createElement('div');
    bar.id = 'cpps-presence';
    bar.style.cssText = 'display:flex;align-items:center;gap:6px;font:13px system-ui,sans-serif;';
    (document.querySelector('[data-presence-slot]') || document.body).prepend(bar);
  }

  function render(people) {
    const bar = document.getElementById('cpps-presence');
    if (!bar) return;

    const seen = new Map();
    for (const p of people) {
      if (!p.name) continue;
      const prior = seen.get(p.name);
      if (!prior || (p.editing_id && !prior.editing_id)) seen.set(p.name, p);
    }
    const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));

    bar.replaceChildren();

    const label = document.createElement('span');
    label.style.cssText = 'color:#666;margin-right:2px;white-space:nowrap;';
    label.textContent = list.length <= 1 ? 'Just you' : `${list.length} here`;
    bar.appendChild(label);

    for (const p of list) {
      const dot = document.createElement('span');
      dot.title = p.editing_id
        ? `${p.name} — editing a record`
        : `${p.name}${p.page ? ' — ' + p.page : ''}`;
      dot.textContent = initials(p.name);
      dot.style.cssText =
        'width:26px;height:26px;border-radius:50%;display:inline-flex;' +
        'align-items:center;justify-content:center;font-size:11px;color:#fff;flex:none;' +
        `background:${tint(p.name)};` +
        (p.editing_id ? 'box-shadow:0 0 0 2px #fff,0 0 0 4px #e0a020;' : '');
      bar.appendChild(dot);
    }
  }

  /* ---------------------------------------------------------------
   * Realtime
   * ------------------------------------------------------------- */

  function connect() {
    channel = client.channel('cpps-tracker', {
      config: { presence: { key: me.session } }
    });

    channel.on('presence', { event: 'sync' }, () => {
      render(Object.values(channel.presenceState()).flat());
    });

    channel.on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: TABLE, filter: `key=eq.${KEY}` },
      payload => {
        if (payload.new && payload.new.version === localVersion) return; // our own write
        scheduleRefresh();
      });

    channel.subscribe(async status => {
      if (status === 'SUBSCRIBED') { await track(); refresh(); }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') startFallback();
    });
  }

  function track() {
    return channel
      ? channel.track({ name: me.name, page: me.page, editing_id: me.editing })
      : Promise.resolve();
  }

  let fallback = null;
  function startFallback() {
    if (fallback) return;
    console.warn('[tracker] realtime unavailable — polling every 20s');
    fallback = setInterval(() => { if (!document.hidden) refresh(); }, 20000);
  }

  /* ---------------------------------------------------------------
   * Public API
   * ------------------------------------------------------------- */

  function start(opts = {}) {
    if (!window.supabase) return console.error('[tracker] supabase-js not loaded');

    onData = opts.onData;
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

    me = {
      session: Math.random().toString(36).slice(2),
      name: identify(opts.people),
      page: opts.page || null,
      editing: null
    };

    mount();
    connect();

    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    window.addEventListener('pagehide', () => channel && channel.untrack());
  }

  function setEditing(recordId) {
    if (!me) return;
    isEditing = !!recordId;
    me.editing = recordId || null;
    track();
    if (!isEditing && missed) refresh();
  }

  function editorOf(recordId) {
    if (!channel) return null;
    const other = Object.values(channel.presenceState()).flat()
      .find(p => p.editing_id === recordId && p.name !== me.name);
    return other ? other.name : null;
  }

  function setPage(name) { if (me) { me.page = name; track(); } }

  function rename() { localStorage.removeItem('cpps_name'); location.reload(); }

  return { start, saveRecord, deleteRecord, refresh, setEditing, editorOf, setPage, rename };
})();
