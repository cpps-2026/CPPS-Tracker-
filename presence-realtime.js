const SUPABASE_URL = 'https://eggszukiqudidbpdghkh.supabase.co';
const SUPABASE_KEY = 'sb_publishable_wyHJ-ll0wAskXbJYiWjWLg_4kw4hT4O';
const TABLE        = 'opportunities';

const Presence = (() => {

  const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
  const SUPABASE_KEY = 'YOUR-PUBLISHABLE-KEY';
  const TABLE        = 'opportunities';

  const POLL_FALLBACK_MS = 20000;  // only used if the socket won't connect
  const DEBOUNCE_MS      = 400;    // coalesce bursts of row changes

  let client = null;
  let channel = null;
  let me = null;
  let onData = null;
  let isEditing = false;
  let missedWhileEditing = false;
  let refetchTimer = null;
  let fallbackTimer = null;

  /* ---------------------------------------------------------------
   * Data
   * ------------------------------------------------------------- */

  async function fetchRows() {
    const { data, error } = await client.from(TABLE).select('*');
    if (error) throw error;
    return data;
  }

  async function refresh() {
    if (isEditing) { missedWhileEditing = true; return; }
    try {
      const rows = await fetchRows();
      if (typeof onData === 'function') onData(rows);
      missedWhileEditing = false;
    } catch (err) {
      console.warn('[presence] fetch failed', err);
    }
  }

  // A save can fire INSERT + several UPDATEs in a row. Wait for the dust.
  function scheduleRefresh() {
    clearTimeout(refetchTimer);
    refetchTimer = setTimeout(refresh, DEBOUNCE_MS);
  }

  /* ---------------------------------------------------------------
   * Identity
   * ------------------------------------------------------------- */

  function identify(names) {
    const saved = localStorage.getItem('cpps_name');
    if (saved) return saved;

    let name = null;
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
   * The avatar bar
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

    // One person, two tabs = one avatar. Collapse on name.
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
      const state = channel.presenceState();
      render(Object.values(state).flat());
    });

    channel.on('postgres_changes',
      { event: '*', schema: 'public', table: TABLE },
      scheduleRefresh
    );

    channel.subscribe(async status => {
      if (status === 'SUBSCRIBED') {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
        await track();
        refresh();
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        startFallback();
      }
    });
  }

  function track() {
    if (!channel) return Promise.resolve();
    return channel.track({
      name: me.name,
      page: me.page,
      editing_id: me.editing,
      joined_at: me.joinedAt
    });
  }

  // If the WebSocket can't establish (corporate proxy, blocked ws://),
  // fall back to polling so the tracker still self-updates.
  function startFallback() {
    if (fallbackTimer) return;
    console.warn('[presence] realtime unavailable — falling back to polling');
    fallbackTimer = setInterval(() => {
      if (!document.hidden) refresh();
    }, POLL_FALLBACK_MS);
  }

  /* ---------------------------------------------------------------
   * Public API
   * ------------------------------------------------------------- */

  function start(opts = {}) {
    if (!window.supabase) {
      console.error('[presence] supabase-js not loaded — check the CDN script tag');
      return;
    }

    onData = opts.onData;
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

    me = {
      session: Math.random().toString(36).slice(2),
      name: identify(opts.people),
      page: opts.page || null,
      editing: null,
      joinedAt: new Date().toISOString()
    };

    mount();
    connect();

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refresh();
    });

    window.addEventListener('pagehide', () => { if (channel) channel.untrack(); });
  }

  // Call after a successful save. Realtime tells everyone else; this is
  // just so the person who saved doesn't wait on the round trip.
  function notifyChange() { scheduleRefresh(); }

  // Call when the edit modal opens and closes. Blocks re-renders that
  // would wipe a half-filled form, and shows others who's in the record.
  function setEditing(recordId) {
    if (!me) return;
    isEditing = !!recordId;
    me.editing = recordId || null;
    track();
    if (!isEditing && missedWhileEditing) refresh();
  }

  // Returns the name of anyone else already in this record, or null.
  function editorOf(recordId) {
    if (!channel) return null;
    const others = Object.values(channel.presenceState()).flat()
      .filter(p => p.editing_id === recordId && p.name !== me.name);
    return others.length ? others[0].name : null;
  }

  function setPage(name) {
    if (!me) return;
    me.page = name;
    track();
  }

  function rename() {
    localStorage.removeItem('cpps_name');
    location.reload();
  }

  return { start, notifyChange, setEditing, setPage, editorOf, rename };
})();
