// Bloom Principal Pulse — Supabase data layer.
// Replaces the localStorage layer of the design prototype. Loaded from the .dc.html <helmet>
// alongside the supabase-js UMD bundle; exposes window.BloomAPI.
//
// Mapping (see README "Client integration points"):
//   bloom-pulse-school       -> profiles.school_id from the session
//   bloom-pulse-draft:<s>    -> stays in localStorage (drafts are device-local by design)
//   bloom-pulse-submissions  -> pulses upsert + network_pulse() RPC
//   bloom-pulse-requests     -> support_requests
//   bloom-pulse-shared       -> shared_resources
//   bloom-pulse-rewards      -> points_ledger + redemptions
//   window.claude.complete   -> POST /functions/v1/tailor

(function () {
  var CONFIG = window.BLOOM_SUPABASE || {};
  var client = null;

  function sb() {
    if (client) return client;
    if (!window.supabase || !CONFIG.url || !CONFIG.key) return null;
    client = window.supabase.createClient(CONFIG.url, CONFIG.key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    return client;
  }

  // Wait for the supabase-js UMD bundle to finish loading (it is a plain <script> tag).
  function ready() {
    return new Promise(function (resolve) {
      if (sb()) return resolve(sb());
      var n = 0;
      var t = setInterval(function () {
        if (sb() || ++n > 100) { clearInterval(t); resolve(sb()); }
      }, 50);
    });
  }

  function unwrap(res) {
    if (res && res.error) throw res.error;
    return res ? res.data : null;
  }

  // What people can actually paste is rarely a clean URL: mail clients wrap it in <>, some
  // copy the address bar of a page that never loaded (no scheme), and a fragment copied on
  // its own has no host at all. None of those are bad links, and rejecting them sends someone
  // back to an inbox for a second link that will fail exactly the same way.
  function normaliseLink(pasted) {
    var v = String(pasted || '').trim().replace(/\s+/g, '')
      .replace(/^[<("']+/, '').replace(/[>)"']+$/, '');
    if (!v) return '';
    // A fragment on its own — "#access_token=…" or just "access_token=…". The host is never
    // read on that path, so any placeholder host will do.
    if (v.charAt(0) === '#') return 'https://pasted.invalid/' + v;
    if (/^access_token=/.test(v)) return 'https://pasted.invalid/#' + v;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
    // Scheme-less, but only if it still looks like an address: a host followed by a path,
    // query or fragment, or a bare domain. Plain prose must stay a bad link, or "hello"
    // becomes https://hello and gets answered with "that link wasn't sent by Bloom".
    if (/^[^/?#]+[/?#]/.test(v) || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v)) return 'https://' + v;
    return v;
  }

  // Reads the `iss` claim of an access token without trusting it for anything else — the
  // server still validates the signature. This only decides whether a pasted token is even
  // worth handing to setSession, so a malformed one is simply "not ours".
  function issuedByProject(jwt, projectOrigin) {
    try {
      var part = String(jwt).split('.')[1];
      if (!part) return false;
      var b64 = part.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var claims = JSON.parse(decodeURIComponent(escape(atob(b64))));
      return typeof claims.iss === 'string' && claims.iss.indexOf(projectOrigin + '/') === 0;
    } catch (e) { return false; }
  }

  var API = {
    configured: function () { return !!(CONFIG.url && CONFIG.key); },
    ready: ready,
    client: sb,

    // ---- auth -------------------------------------------------------------
    getSession: async function () {
      var c = await ready(); if (!c) return null;
      var res = await c.auth.getSession();
      return res && res.data ? res.data.session : null;
    },
    onAuthChange: function (cb) {
      ready().then(function (c) { if (c) c.auth.onAuthStateChange(function (_e, session) { cb(session); }); });
    },
    // Magic link only. shouldCreateUser is true because pilot_allowlist is the gate, not a
    // manual invite: the on_auth_user_created hook rejects any address that is not listed
    // (no auth.users row is created) and provisions the profile for any address that is.
    // With it false, a listed person who had never been invited got no email at all.
    sendMagicLink: async function (email) {
      var c = await ready(); if (!c) throw new Error('offline');
      var res = await c.auth.signInWithOtp({
        email: String(email || '').trim(),
        options: { shouldCreateUser: true, emailRedirectTo: window.location.origin + window.location.pathname },
      });
      if (res.error) throw res.error;
      return true;
    },
    signOut: async function () {
      var c = await ready(); if (!c) return;
      await c.auth.signOut();
    },
    // Rescue path for a sign-in link that could not complete its redirect — the usual cause
    // is Supabase's Site URL not yet pointing at this app, so the link lands on localhost.
    // Accepts either form:
    //   the link from the email        .../auth/v1/verify?token=...&type=magiclink
    //   the URL it landed on           http://localhost:3000/#access_token=...&refresh_token=...
    completeSignIn: async function (pasted) {
      var c = await ready(); if (!c) throw new Error('offline');
      var url, project;
      try { url = new URL(normaliseLink(pasted)); } catch (e) { throw new Error('bad_link'); }
      try { project = new URL(CONFIG.url).origin; } catch (e) { throw new Error('offline'); }

      // Already-verified link: the session is sitting in the fragment.
      var frag = new URLSearchParams((url.hash || '').replace(/^#/, ''));
      var access = frag.get('access_token'), refresh = frag.get('refresh_token');
      if (access && refresh) {
        // This box installs whatever session it is given, so anyone who can get a link in
        // front of a principal can sign that principal into an account of their choosing —
        // and every write the principal then makes lands in that account's school. The
        // address cannot be checked (the whole point of the rescue is a link that landed on
        // the wrong origin, usually localhost), so check the token instead: it must have been
        // issued by this Supabase project. That leaves only a session minted by this project,
        // which the pilot allow-list already limits to a known, named group of people.
        if (!issuedByProject(access, project)) throw new Error('foreign_link');
        var set = await c.auth.setSession({ access_token: access, refresh_token: refresh });
        if (set.error) throw set.error;
        return set.data;
      }

      // Unclicked link: exchange the token for a session directly, no redirect involved.
      // The email's link always points at this project's auth endpoint; anything else is not
      // a Bloom sign-in link, whatever it claims.
      if (url.origin !== project) throw new Error('foreign_link');
      var token = url.searchParams.get('token_hash') || url.searchParams.get('token');
      if (!token) throw new Error('bad_link');

      // The type decides which table GoTrue looks the token up in, and getting it wrong reads
      // as "invalid or expired" — indistinguishable, to the person pasting, from a dead link.
      // A first-time sign-in arrives as type=signup (the "Confirm your email address" mail),
      // not magiclink, so try the type the link carries and then the others rather than
      // telling someone their perfectly good link is expired.
      var types = [url.searchParams.get('type'), 'magiclink', 'signup', 'email']
        .filter(function (t, i, a) { return t && a.indexOf(t) === i; });
      var last = null;
      for (var i = 0; i < types.length; i++) {
        var res = await c.auth.verifyOtp({ token_hash: token, type: types[i] });
        if (!res.error) return res.data;
        last = res.error;
      }
      throw last;
    },
    // Returns {profile} when the row exists, {absent:true} when the user is genuinely not on
    // the pilot list, {failed:true} when we could not find out. Collapsing the last two would
    // sign a valid user out mid-session and tell them they are not on the list.
    loadProfile: async function () {
      var c = await ready(); if (!c) return { failed: true };
      var u = await c.auth.getUser();
      var user = u && u.data ? u.data.user : null;
      if (!user) return { failed: true };
      var res = await c.from('profiles').select('user_id, email, school_id, role, display_name').eq('user_id', user.id).maybeSingle();
      if (res.error) return { failed: true };
      return res.data ? { profile: res.data } : { absent: true };
    },

    // ---- reference data ---------------------------------------------------
    listSchools: async function () {
      var c = await ready(); if (!c) return [];
      return unwrap(await c.from('schools').select('id, name, short_name, region').order('name')) || [];
    },
    listPerks: async function () {
      var c = await ready(); if (!c) return [];
      return unwrap(await c.from('perks').select('*').order('cost')) || [];
    },

    // ---- step 1: this school's pulse --------------------------------------
    myPulse: async function (weekStart) {
      var c = await ready(); if (!c) return null;
      return unwrap(await c.from('pulses').select('*').eq('week_start', weekStart).maybeSingle());
    },
    // Own pulses over a window, for the streak. RLS limits this to the signed-in school.
    myPulseHistory: async function (sinceISO) {
      var c = await ready(); if (!c) return [];
      return unwrap(await c.from('pulses').select('week_start, topic').gte('week_start', sinceISO).order('week_start', { ascending: false })) || [];
    },
    upsertPulse: async function (p) {
      var c = await ready(); if (!c) throw new Error('offline');
      return unwrap(await c.from('pulses').upsert({
        school_id: p.schoolId,
        week_start: p.weekStart,
        topic: p.topic,
        impact: p.impact,
        note: p.note && p.note.trim() ? p.note.trim().slice(0, 240) : null,
        submitted_by: p.userId,
        submitted_at: new Date().toISOString(),
      }, { onConflict: 'school_id,week_start' }).select().single());
    },

    // ---- step 2: aggregated network view ----------------------------------
    // Server-side aggregation with the minimum-cell rule. Never returns other schools' rows.
    networkPulse: async function (weekStart) {
      var c = await ready(); if (!c) return null;
      return unwrap(await c.rpc('network_pulse', { p_week_start: weekStart }));
    },

    // ---- support requests -------------------------------------------------
    listRequests: async function () {
      var c = await ready(); if (!c) return [];
      return unwrap(await c.from('support_requests').select('*').order('created_at', { ascending: false }).limit(50)) || [];
    },
    insertRequest: async function (r) {
      var c = await ready(); if (!c) throw new Error('offline');
      return unwrap(await c.from('support_requests').insert({
        ref: r.ref,
        school_id: r.schoolId,
        week_start: r.weekStart,
        type: r.type,
        topic: r.topic,
        impact: r.impact || null,
        context: r.context ? r.context.slice(0, 300) : null,
        help: r.help ? r.help.slice(0, 300) : null,
        created_by: r.userId,
      }).select().single());
    },

    // ---- shared resources -------------------------------------------------
    listShared: async function () {
      var c = await ready(); if (!c) return [];
      return unwrap(await c.from('shared_resources').select('*').order('created_at', { ascending: false }).limit(20)) || [];
    },
    addShared: async function (x) {
      var c = await ready(); if (!c) throw new Error('offline');
      return unwrap(await c.from('shared_resources').insert({
        school_id: x.schoolId, topic: x.topic, title: x.title, try_it: x.tryIt, text: x.text, created_by: x.userId,
      }).select().single());
    },
    removeShared: async function (id) {
      var c = await ready(); if (!c) return;
      var res = await c.from('shared_resources').delete().eq('id', id);
      if (res.error) throw res.error;
    },

    // ---- points & perks ---------------------------------------------------
    // Points are always the server's sum(delta); the client never does its own arithmetic.
    listLedger: async function () {
      var c = await ready(); if (!c) return [];
      return unwrap(await c.from('points_ledger').select('week_start, kind, delta, created_at').order('created_at', { ascending: false })) || [];
    },
    listRedemptions: async function () {
      var c = await ready(); if (!c) return [];
      return unwrap(await c.from('redemptions').select('*')) || [];
    },
    redeem: async function (perkId) {
      return API.invoke('redeem', { perk_id: perkId });
    },

    // ---- AI proxy ---------------------------------------------------------
    tailor: async function (payload) {
      return API.invoke('tailor', payload);
    },

    // Shared edge-function caller: attaches the session JWT.
    invoke: async function (name, body) {
      var c = await ready(); if (!c) throw new Error('offline');
      var s = await c.auth.getSession();
      var token = s && s.data && s.data.session ? s.data.session.access_token : null;
      if (!token) throw new Error('unauthenticated');
      var r = await fetch(CONFIG.url + '/functions/v1/' + name, {
        method: 'POST',
        headers: { 'content-type': 'application/json', apikey: CONFIG.key, authorization: 'Bearer ' + token },
        body: JSON.stringify(body || {}),
      });
      var j = null;
      try { j = await r.json(); } catch (e) { j = null; }
      if (!r.ok) {
        var err = new Error((j && (j.error || j.status)) || ('http ' + r.status));
        err.status = r.status; err.payload = j;
        throw err;
      }
      return j;
    },
  };

  window.BloomAPI = API;
})();
