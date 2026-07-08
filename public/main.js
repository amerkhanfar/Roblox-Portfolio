import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

/* =====================================================================
   Helpers
===================================================================== */
const $ = (s, r = document) => r.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function fmt(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(n));
}
const fmtComma = (n) => (Number(n) || 0).toLocaleString("en-US");

/* =====================================================================
   Roblox data — fetched live in the browser via RoProxy, a CORS-friendly
   public mirror of Roblox's API (Roblox blocks direct browser calls).
   No server needed. universeIds are baked in so we skip 16 lookups.
===================================================================== */
const ROBLOX_USER_ID = 5521424624;
const AVATAR_FALLBACK =
  "https://tr.rbxcdn.com/30DAY-Avatar-30D42F2F5988DBEDBDD8FA87F0430A82-Png/720/720/Avatar/Png/noFilter";

// `like` (approval %) is baked in — it changes very slowly and its votes
// endpoint isn't reliably proxyable. Visits / players / favorites stay live.
const GAMES = [
  { placeId: "139862517286509", universeId: 8473646150,  like: 97.8 }, // Power Simulator X
  { placeId: "119382507680341", universeId: 10001527292, like: 91.4 }, // My SkatePark
  { placeId: "107430757519116", universeId: 10130680213, like: 73.9 }, // WYR Anime Tower
  { placeId: "140305746641797", universeId: 10065612488, like: 87.8 }, // Fish Empire
  { placeId: "127364241509157", universeId: 9908137395,  like: 88.7 }, // Build a Bridge / Sniper
  { placeId: "137533474840546", universeId: 10061909806, like: 85.6 }, // Sneak Out
  { placeId: "106159203290418", universeId: 7538895650,  like: 84.6 }, // Kraken Game
  { placeId: "132473176738458", universeId: 10110629028, like: 89.7 }, // My Soccer Park
  { placeId: "122964125911374", universeId: 10046412802, like: 91.4 }, // My Trampoline Park
  { placeId: "76469560314137",  universeId: 9759341824,  like: 80.6 }, // Dodgeball
  { placeId: "105286263263507", universeId: 10080131877, like: 96.6 }, // Shoot a Lucky Block
  { placeId: "80885214023481",  universeId: 9898638684,  like: 60.9 }, // Cortisol Level Tower
  { placeId: "79436299646095",  universeId: 8209640691,  like: 96.1 }, // One of Us
  { placeId: "70871855898838",  universeId: 8986150911,  like: 52.6 }, // Stop The Timer
  { placeId: "15277199491",     universeId: 5268677200,  like: 91.0 }, // Stunt Simulator
  { placeId: "107750563478039", universeId: 10205485380, like: 83.1 }, // Penalty Kicks
];

// Roblox's API blocks direct browser calls (CORS). Route through a CORS
// mirror (RoProxy = swap the domain), with allorigins as a backup.
const PROXIES = [
  (u) => u.replace(/\.roblox\.com/, ".roproxy.com"),
  (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
];
async function rbxFetch(url) {
  let err;
  for (const wrap of PROXIES) {
    try {
      const r = await fetch(wrap(url));
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) { err = e; }
  }
  throw err;
}
async function getAvatarUrl() {
  try {
    const d = await rbxFetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${ROBLOX_USER_ID}&size=720x720&format=Png&isCircular=false`);
    return (d.data && d.data[0] && d.data[0].imageUrl) || AVATAR_FALLBACK;
  } catch { return AVATAR_FALLBACK; }
}

/* =====================================================================
   THREE — the character that follows you through the page
===================================================================== */
const CharacterScene = (() => {
  const canvas = $("#scene");
  let renderer, scene, camera, group, halo;
  let baseRotY = 0;
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  const pos = new THREE.Vector3(2.4, 0, 0);
  const target = { x: 2.4, y: 0, scale: 1, opacity: 1 };
  const clock = new THREE.Clock();

  // anchor = where the character sits per section, in fractions of the
  // viewport (x: 0.5 = right edge, y: +up). Right-side throughout so it
  // reads as a guide travelling down the page with you.
  const anchors = {
    hero:    { x: 0.27, y: 0.04,  scale: 0.96, opacity: 1.0 },
    work:    { x: 0.33, y: -0.3,  scale: 0.42, opacity: 0.78 },
    twitter: { x: 0.33, y: -0.28, scale: 0.46, opacity: 0.85 },
    contact: { x: 0.32, y: 0.04,  scale: 0.6,  opacity: 0.95 },
  };
  // On narrow screens the canvas covers the text, so keep the character a
  // faint, smaller background accent in the corner — text stays readable.
  const mobileAnchors = {
    hero:    { x: 0.3,  y: 0.26,  scale: 0.6,  opacity: 0.34 },
    work:    { x: 0.32, y: -0.34, scale: 0.4,  opacity: 0.28 },
    twitter: { x: 0.32, y: -0.32, scale: 0.42, opacity: 0.3 },
    contact: { x: 0.28, y: 0.08,  scale: 0.5,  opacity: 0.3 },
  };
  const getAnchors = () => (window.innerWidth <= 720 ? mobileAnchors : anchors);
  const order = ["hero", "work", "twitter", "contact"];

  function supported() {
    try {
      const c = document.createElement("canvas");
      return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
    } catch { return false; }
  }

  function worldFromFraction(fx, fy, z = 0) {
    const dist = camera.position.z - z;
    const vH = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * dist;
    const vW = vH * camera.aspect;
    return { x: fx * vW, y: fy * vH };
  }

  function makeGlowTexture() {
    const s = 256;
    const cv = document.createElement("canvas");
    cv.width = cv.height = s;
    const ctx = cv.getContext("2d");
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, "rgba(120,190,255,0.95)");
    g.addColorStop(0.4, "rgba(60,130,255,0.45)");
    g.addColorStop(1, "rgba(20,60,160,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  function buildStage() {
    group = new THREE.Group();
    scene.add(group);

    // glow halo behind the character
    const glowTex = makeGlowTexture();
    halo = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTex, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    halo.scale.set(4.6, 4.6, 1);
    halo.position.z = -0.6;
    group.add(halo);

    // subtle holographic platform rings under the feet
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x49b4ff, transparent: true, opacity: 0.32 });
    const ring1 = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.012, 8, 90), ringMat);
    ring1.rotation.x = Math.PI / 2.5;
    ring1.position.y = -1.65;
    group.add(ring1);
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.01, 8, 80), ringMat.clone());
    ring2.material.opacity = 0.2;
    ring2.rotation.x = Math.PI / 2.5;
    ring2.position.y = -1.62;
    group.add(ring2);
    group.userData.rings = [ring1, ring2];

    // floating particle halo around the character
    const N = 90;
    const geo = new THREE.BufferGeometry();
    const arr = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r = 1.6 + Math.random() * 1.6;
      const a = Math.random() * Math.PI * 2;
      const yy = (Math.random() - 0.5) * 4;
      arr[i * 3] = Math.cos(a) * r;
      arr[i * 3 + 1] = yy;
      arr[i * 3 + 2] = Math.sin(a) * r;
    }
    geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    const pts = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ color: 0x7fc4ff, size: 0.045, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    group.add(pts);
    group.userData.pts = pts;
  }

  // Your real Roblox avatar render — image straight from Roblox's CDN
  // (CORS-OK for WebGL), floated in the holographic stage with a soft aura,
  // a glowing floor pad, and a cursor-reactive tilt (2.5D life).
  function addBillboard(url) {
    // soft blue aura behind the avatar so it pops off the dark background
    const aura = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeGlowTexture(), transparent: true, opacity: 0.7,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    aura.scale.set(5.4, 5.4, 1);
    aura.position.set(0, 0.25, -0.9);
    group.add(aura);
    group.userData.aura = aura;

    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    loader.load(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 8;
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(3.7, 3.7),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
      );
      plane.position.set(0, 0.2, 0.15);
      group.add(plane);
      group.userData.avatarPlane = plane;
    });

    // glowing holographic floor pad
    const pad = new THREE.Mesh(
      new THREE.CircleGeometry(1.0, 48),
      new THREE.MeshBasicMaterial({ map: makeGlowTexture(), transparent: true, opacity: 0.5, depthWrite: false })
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = -1.6;
    pad.scale.set(1.6, 1.6, 1);
    group.add(pad);
  }

  function currentAnchor() {
    const A = getAnchors();
    const cy = window.scrollY + window.innerHeight / 2;
    const secs = order
      .map((id) => { const el = document.getElementById(id); return el ? { id, top: el.offsetTop, h: el.offsetHeight } : null; })
      .filter(Boolean);
    for (let i = 0; i < secs.length; i++) {
      const s = secs[i], next = secs[i + 1];
      const start = s.top, end = next ? next.top : s.top + s.h;
      if ((cy >= start && cy < end) || i === secs.length - 1) {
        // hold the current section's anchor for most of the section, then
        // transition near the boundary — keeps the character settled, not drifting.
        const raw = clamp((cy - start) / (end - start || 1), 0, 1);
        const t = easeInOut(clamp((raw - 0.55) / 0.45, 0, 1));
        const a = A[s.id], b = A[next ? next.id : s.id];
        return {
          x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t),
          scale: lerp(a.scale, b.scale, t), opacity: lerp(a.opacity, b.opacity, t),
        };
      }
    }
    return A.hero;
  }

  function setOpacity(o) {
    group.traverse((c) => {
      if (c.material && "opacity" in c.material) {
        c.material.transparent = true;
        const base = c.userData.baseOpacity ?? c.material.opacity;
        c.userData.baseOpacity = base;
        c.material.opacity = base * o;
      }
    });
  }

  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function animate() {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();

    const a = currentAnchor();
    const world = worldFromFraction(a.x, a.y);
    target.x = world.x; target.y = world.y; target.scale = a.scale; target.opacity = a.opacity;

    // smooth follow
    pos.x = lerp(pos.x, target.x, 0.06);
    pos.y = lerp(pos.y, target.y, 0.06);
    const float = Math.sin(t * 1.1) * 0.12;
    group.position.set(pos.x, pos.y + float, 0);
    const sc = lerp(group.scale.x || 1, target.scale, 0.08);
    group.scale.setScalar(sc);

    // mesh: gentle showcase sway. flat avatar render: keep facing camera and
    // tilt the plane itself toward the cursor for a 2.5D floating-card feel.
    mouse.x = lerp(mouse.x, mouse.tx, 0.05);
    mouse.y = lerp(mouse.y, mouse.ty, 0.05);
    const spin = group.userData.spin;
    baseRotY = Math.sin(t * 0.4) * (spin ? 0.5 : 0);
    group.rotation.y = baseRotY + mouse.x * (spin ? 0.3 : 0);
    group.rotation.x = spin ? -mouse.y * 0.05 : 0;
    if (group.userData.avatarPlane) {
      const p = group.userData.avatarPlane;
      p.rotation.y = lerp(p.rotation.y, mouse.x * 0.22, 0.08);
      p.rotation.x = lerp(p.rotation.x, -mouse.y * 0.12, 0.08);
    }

    if (group.userData.rings) {
      group.userData.rings[0].rotation.z += 0.004;
      group.userData.rings[1].rotation.z -= 0.006;
    }
    if (group.userData.pts) group.userData.pts.rotation.y += 0.0015;
    if (halo) halo.material.opacity = 0.7 + Math.sin(t * 1.6) * 0.15;

    setOpacity(target.opacity);
    renderer.render(scene, camera);
  }

  async function init() {
    if (!canvas || !supported()) {
      const fb = $("#scene-fallback"); if (fb) fb.style.opacity = "1";
      return;
    }
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 0, 7);

    // soft environment for realistic reflections
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    scene.add(new THREE.AmbientLight(0x9bc4ff, 0.35));
    const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(2, 3, 4); scene.add(key);
    const rim = new THREE.DirectionalLight(0x35d6ff, 1.4); rim.position.set(-3, 1, -2); scene.add(rim);
    const fill = new THREE.PointLight(0x2f6bff, 10, 30); fill.position.set(0, -2, 3); scene.add(fill);

    buildStage();
    resize();
    animate();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", (e) => {
      mouse.tx = (e.clientX / window.innerWidth - 0.5) * 2;
      mouse.ty = (e.clientY / window.innerHeight - 0.5) * 2;
    });

    // load your real Roblox avatar render (CORS mirror; cached-URL fallback)
    addBillboard(await getAvatarUrl());
  }

  return { init };
})();

/* =====================================================================
   Live game data + cards
===================================================================== */
async function loadGames() {
  const grid = $("#games-grid");
  const ids = GAMES.map((g) => g.universeId).join(",");
  try {
    const [details, thumbs] = await Promise.all([
      rbxFetch(`https://games.roblox.com/v1/games?universeIds=${ids}`),
      rbxFetch(`https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=${ids}&countPerUniverse=1&defaults=true&size=768x432&format=Png&isCircular=false`).catch(() => ({ data: [] })),
    ]);
    const { games, totals } = buildGames(details, thumbs);
    if (!games.length) throw new Error("empty");
    renderHeroStats(totals);
    renderCards(games, grid);
  } catch (e) {
    grid.innerHTML = `<div class="empty-note">Live Roblox stats are momentarily unavailable — please refresh in a moment.</div>`;
  }
}

// merge live details + thumbnails with the baked like ratio, rank by visits
function buildGames(details, thumbs) {
  const dMap = new Map((details.data || []).map((d) => [d.id, d]));
  const tMap = new Map((thumbs.data || []).map((t) => [t.universeId, (t.thumbnails && t.thumbnails[0] && t.thumbnails[0].imageUrl) || null]));
  const games = GAMES.map(({ placeId, universeId, like }) => {
    const d = dMap.get(universeId);
    if (!d) return null;
    return {
      universeId, placeId, name: d.name, playing: d.playing || 0, visits: d.visits || 0,
      favorites: d.favoritedCount || 0, likeRatio: like || 0,
      thumbnail: tMap.get(universeId) || null,
      url: `https://www.roblox.com/games/${placeId}/`,
    };
  }).filter(Boolean).sort((a, b) => b.visits - a.visits);
  const totals = {
    visits: games.reduce((s, g) => s + g.visits, 0),
    playing: games.reduce((s, g) => s + g.playing, 0),
    count: games.length,
  };
  return { games, totals };
}

function renderCards(games, grid) {
  if (!games || !games.length) {
    grid.innerHTML = `<div class="empty-note">No games to show yet.</div>`;
    return;
  }
  grid.innerHTML = "";
  games.forEach((g, i) => {
    const rank = i + 1;
    const like = g.likeRatio ? g.likeRatio.toFixed(1) : "—";
    const thumb = g.thumbnail
      ? `<img src="${g.thumbnail}" alt="${escapeHtml(g.name)}" loading="lazy" />`
      : "";
    const card = document.createElement("a");
    card.className = "card";
    card.href = g.url;
    card.target = "_blank";
    card.rel = "noopener";
    card.style.transitionDelay = `${Math.min(i, 8) * 50}ms`;
    card.innerHTML = `
      <span class="card__rank ${rank <= 3 ? "top" : ""}">#${rank}</span>
      <span class="card__live"><span class="pulse"></span>${fmtComma(g.playing)} playing</span>
      <div class="card__thumb">${thumb}</div>
      <div class="card__body">
        <h3 class="card__name">${escapeHtml(g.name)}</h3>
        <div class="likebar"><i style="width:${g.likeRatio || 0}%"></i></div>
        <div class="card__stats">
          <div class="cstat"><span class="cstat__v">${fmt(g.visits)}</span><span class="cstat__l">Visits</span></div>
          <div class="cstat cstat--like"><span class="cstat__v">${like}%</span><span class="cstat__l">Likes</span></div>
          <div class="cstat"><span class="cstat__v">${fmt(g.favorites)}</span><span class="cstat__l">Favs</span></div>
        </div>
        <span class="card__play">Play on Roblox
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17 17 7M9 7h8v8"/></svg>
        </span>
      </div>`;
    grid.appendChild(card);
    revealObserver.observe(card);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* animated hero counters */
function renderHeroStats(totals) {
  if (!totals) return;
  countTo($("#stat-visits"), totals.visits, fmt);
  countTo($("#stat-live"), totals.playing, fmtComma);
  countTo($("#stat-games"), totals.count, (n) => String(Math.round(n)));
}
function countTo(el, value, format) {
  if (!el) return;
  const dur = 1500, start = performance.now();
  function step(now) {
    const t = clamp((now - start) / dur, 0, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = format(value * eased);
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = format(value);
  }
  requestAnimationFrame(step);
}

/* =====================================================================
   Reveal on scroll, nav, twitter, misc
===================================================================== */
const revealObserver = new IntersectionObserver(
  (entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); revealObserver.unobserve(e.target); } }),
  { threshold: 0.12 }
);

function initReveal() {
  document.querySelectorAll(".reveal").forEach((el) => revealObserver.observe(el));
}

function initNav() {
  const nav = $("#nav");
  const links = [...document.querySelectorAll(".nav__links a")];
  const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 30);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  const sections = links
    .map((a) => document.querySelector(a.getAttribute("href")))
    .filter(Boolean);
  const spy = new IntersectionObserver(
    (entries) => entries.forEach((e) => {
      if (e.isIntersecting) {
        links.forEach((l) => l.classList.toggle("active", l.getAttribute("href") === "#" + e.target.id));
      }
    }),
    { threshold: 0.45 }
  );
  sections.forEach((s) => spy.observe(s));
}

/* OPTIONAL: paste up to 3 of your tweet/post URLs (or IDs) here to show those
   exact posts. Individual post embeds are far more reliable than X's profile-
   timeline embed (which X often serves empty). Leave empty to try the timeline.
   Example: ["https://x.com/ItzAmerBlox/status/1790000000000000000"] */
const FEATURED_TWEETS = [
  "https://x.com/ItzAmerBlox/status/2020120363951120406",
  "https://x.com/ItzAmerBlox/status/1959963980027630019",
  "https://x.com/ItzAmerBlox/status/1953838754872881303",
];

function initTwitter() {
  const embed = $("#tw-embed");
  const fallback = $("#tw-fallback");
  const showFallback = () => { embed.hidden = true; fallback.hidden = false; };

  const s = document.createElement("script");
  s.src = "https://platform.twitter.com/widgets.js";
  s.async = true;
  s.charset = "utf-8";
  s.onload = () => {
    if (FEATURED_TWEETS.length && window.twttr && twttr.widgets) {
      embed.innerHTML = "";
      let ok = 0;
      const ids = FEATURED_TWEETS.map((u) => (String(u).match(/(\d{8,})/) || [])[1]).filter(Boolean);
      Promise.all(
        ids.slice(0, 3).map((id) => {
          const cell = document.createElement("div");
          cell.className = "tw__cell";
          embed.appendChild(cell);
          return twttr.widgets
            .createTweet(id, cell, { theme: "dark", conversation: "none", align: "center" })
            .then((el) => { if (el) ok++; });
        })
      ).then(() => { if (!ok) showFallback(); });
    } else if (window.twttr && twttr.widgets) {
      twttr.widgets.load(embed);
    }
  };
  document.body.appendChild(s);

  // X profile timelines frequently render an empty 0-height iframe. If nothing
  // real showed up, swap in the styled fallback CTA.
  setTimeout(() => {
    const f = embed.querySelector("iframe");
    const hasTweet = embed.querySelector(".twitter-tweet-rendered");
    if (!hasTweet && (!f || f.offsetHeight < 80)) showFallback();
  }, 5500);
}

/* =====================================================================
   Boot
===================================================================== */
$("#year").textContent = new Date().getFullYear();
initReveal();
initNav();
initTwitter();
loadGames();
CharacterScene.init();
