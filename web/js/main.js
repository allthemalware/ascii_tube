// ascii_tube in the browser: a video element sampled into a character grid,
// drawn on a terminal canvas and shown through the MiNERVA CRT pass. Frames
// are processed here on the page; nothing is uploaded anywhere.

import {
  DEFAULT_RAMP, LONG_RAMP, SEEK_STEP, COLOR_MODES,
  makeDither, computeDims, makeEq, buildCells,
} from "./ascii.js";
import { CRT, POWER_MS, createCRT } from "./crt.js";
import { Terminal, CELL_SIZES } from "./term.js";

// H.264 where the browser has it (some Chromium builds don't), VP9 otherwise.
const SAMPLE = document.createElement("video").canPlayType('video/mp4; codecs="avc1.4d401e"')
  ? { url: "media/sample.mp4", name: "sample.mp4" }
  : { url: "media/sample.webm", name: "sample.webm" };
const PROMPT = "guest@ascii-tube:~$ ";
const STORE_KEY = "ascii_tube.settings";

/* ---- terminal palette (MiNERVA's phosphor greens) ----------------------- */
const C = {
  fg:    [207, 232, 207],   // #cfe8cf default foreground (glows under bloom)
  dim:   [95, 122, 82],     // #5f7a52
  green: [84, 255, 122],
  yellow:[255, 214, 51],
  red:   [255, 90, 90],
  bar:   [44, 60, 38],      // status bar background
};

/* ---- settings: the CLI's flags, plus the tube's own toggles ------------- */
const DEFAULTS = {
  color: "none", dither: false, long: false, invert: false, loop: false,
  brightness: 0, contrast: 1, gamma: 1, cell: 1, amber: false, scanlines: true,
};
// Phones start with 80 columns; everything else with the terminal-ish 160.
if (matchMedia("(max-width: 700px)").matches) DEFAULTS.cell = CELL_SIZES.length - 1;
const settings = { ...DEFAULTS, ...loadSettings(), audio: false };   // muted by default, like --audio

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    return Object.fromEntries(Object.entries(s).filter(([k, v]) => k in DEFAULTS && typeof v === typeof DEFAULTS[k]));
  } catch { return {}; }
}
function saveSettings() {
  try {
    const { audio, ...keep } = settings;
    localStorage.setItem(STORE_KEY, JSON.stringify(keep));
  } catch { /* private mode etc. — settings just won't persist */ }
}

/* ---- DOM ---------------------------------------------------------------- */
const out = document.getElementById("crt");
const content = document.createElement("canvas");
content.width = out.width; content.height = out.height;
const term = new Terminal(content);
const crt = createCRT(out, content);

const video = document.createElement("video");
video.playsInline = true; video.muted = true; video.preload = "auto";
video.setAttribute("aria-hidden", "true");
video.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none";
document.body.appendChild(video);

const sampler = document.createElement("canvas");
const sctx = sampler.getContext("2d", { willReadFrequently: true });

const fileInput = document.createElement("input");
fileInput.type = "file"; fileInput.accept = "video/*"; fileInput.hidden = true;
document.body.appendChild(fileInput);

/* ---- state -------------------------------------------------------------- */
let mode = "off";          // off | boot | play | shell
let showHelp = false;
let source = null;         // { url, name, object }
let sessionLoop = false;
let lastCommand = "";
let shellLines = [];       // scrollback shown in the shell
let typed = "", typeTarget = "", typeNext = 0;
let flashText = "", flashUntil = 0;
let dirty = true, lastVideoTime = -1;
let powerStart = -1;
let grid = null;           // cached geometry for the current video + settings

function applyTube() {
  term.setCellSize(...CELL_SIZES[settings.cell]);
  CRT.mono = settings.amber;
  CRT.scanline = settings.scanlines ? 0.30 : 0;
  grid = null; dirty = true;
}

function flash(text) {
  flashText = text; flashUntil = performance.now() + 1600; dirty = true;
}

/** The terminal command equivalent to what's on screen. */
function command(name) {
  const a = ["ascii-tube", /\s/.test(name) ? `"${name}"` : name];
  if (settings.color !== "none") a.push("--color", settings.color);
  if (settings.dither) a.push("--dither");
  if (settings.long) a.push("--long");
  if (settings.invert) a.push("--invert");
  if (sessionLoop) a.push("--loop");
  if (settings.audio) a.push("--audio");
  if (settings.brightness) a.push("--brightness", +settings.brightness.toFixed(2));
  if (settings.contrast !== 1) a.push("--contrast", +settings.contrast.toFixed(2));
  if (settings.gamma !== 1) a.push("--gamma", +settings.gamma.toFixed(2));
  return a.join(" ");
}

/* ---- playback ----------------------------------------------------------- */
function play(src) {
  if (source && source.object) URL.revokeObjectURL(source.url);
  source = src;
  sessionLoop = settings.loop || src === SAMPLE;
  lastCommand = command(src.name);
  video.loop = sessionLoop;
  video.muted = !settings.audio;
  video.src = src.url;
  grid = null; showHelp = false; lastVideoTime = -1;
  mode = "play"; dirty = true;
  video.play().catch(() => {});
}

function playFile(file) {
  if (!file) return;
  if (file.type && !file.type.startsWith("video/") && !file.type.startsWith("audio/")) {
    toShell([[`ascii-tube: ${file.name}: not a video file`, C.red]]);
    return;
  }
  play({ url: URL.createObjectURL(file), name: file.name, object: true });
}

function toShell(extra = []) {
  video.pause();
  if (mode === "play" && lastCommand) shellLines.push([PROMPT + lastCommand, C.fg]);
  shellLines.push(...extra);
  mode = "shell"; showHelp = false; dirty = true;
}

video.addEventListener("ended", () => { if (!video.loop) toShell(); });
video.addEventListener("error", () => {
  if (mode !== "play") return;
  toShell([[`ascii-tube: can't decode ${source ? source.name : "this file"} in this browser` +
            " (try an H.264 .mp4 or a .webm)", C.red]]);
});
video.addEventListener("loadedmetadata", () => { grid = null; dirty = true; });
["seeked", "pause", "play"].forEach((ev) => video.addEventListener(ev, () => { dirty = true; }));

/** Geometry for the current source + settings, rebuilt only when they change. */
function geometry() {
  if (grid) return grid;
  const charAspect = term.cw / term.ch;
  const [cols, rows] = computeDims(video.videoWidth, video.videoHeight, 0, charAspect, term.cols, term.rows);
  const half = settings.color === "halfblock";
  sampler.width = cols; sampler.height = half ? rows * 2 : rows;
  let ramp = settings.long ? LONG_RAMP : DEFAULT_RAMP;
  if (settings.invert) ramp = [...ramp].reverse().join("");
  grid = {
    cols, rows,
    col0: (term.cols - cols) >> 1,
    row0: (term.rows - 1 - rows) >> 1,
    ramp, nlevels: ramp.length - 1,
    dither: settings.dither && !half ? makeDither(rows, cols) : null,
    eq: makeEq(settings.brightness, settings.contrast, settings.gamma),
  };
  return grid;
}

/* ---- screens ------------------------------------------------------------ */
const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

function statusBar(now) {
  const row = term.rows - 1;
  term.fill(0, row, term.cols, C.bar);
  const state = video.paused ? "‖" : "▶";
  const privacy = term.cols >= 120 ? "  on-device · nothing uploaded" : "";
  let right = flashText && now < flashUntil
    ? ` ${flashText}   `
    : ` ${state} ${fmt(video.currentTime)}/${fmt(video.duration)}  ${grid ? `${grid.cols}×${grid.rows}` : ""}${privacy}   `;
  if (right.length > term.cols - 10) right = right.slice(0, term.cols - 10);
  const left = `  ${lastCommand}`.slice(0, term.cols - right.length - 1);
  term.text(0, row, left, C.fg, C.bar);
  term.text(term.cols - right.length, row, right, C.green, C.bar);
}

const HELP = [
  ["usage: ascii-tube <file> [options]", C.fg],
  ["", C.fg],
  ["Plays a video as ASCII art on a terminal; this one is a CRT in your browser.", C.dim],
  ["Everything runs on your device: your video is never uploaded, copied or", C.yellow],
  ["sent anywhere. There is no server and no tracking.", C.yellow],
  ["", C.fg],
  ["controls", C.green],
  ["  space     pause / resume          c      cycle --color", C.fg],
  ["  q / esc   stop                    d      --dither", C.fg],
  ["  ← / →     seek ∓5 seconds         r      --long (70-level ramp)", C.fg],
  ["  o         open a video file       i      --invert", C.fg],
  ["  enter     play the sample         l      --loop", C.fg],
  ["  ?         this help               a      --audio", C.fg],
  ["  - / =     smaller / larger text   [ / ]  --brightness ∓0.05", C.fg],
  ["  m         amber phosphor          { / }  --contrast ∓0.1", C.fg],
  ["  s         scanlines               g / G  --gamma ∓0.1", C.fg],
  ["  f         fullscreen", C.fg],
  ["", C.fg],
  ["Drop a video file onto the screen to play it.", C.dim],
  ["YouTube links and terminal playback: github.com/allthemalware/ascii_tube", C.dim],
];

// Text screens keep a one-row, two-column margin clear of the tube's curvature.
const MARGIN_ROW = 1, MARGIN_COL = 2;

function drawLines(lines, row0) {
  lines.forEach(([s, col], i) => term.text(MARGIN_COL, row0 + i, s, col));
}

function drawShell(now) {
  const cursor = Math.floor(now / 530) % 2 === 0 ? "█" : " ";
  const tail = [...shellLines.slice(-6), ["", C.fg], ...HELP, ["", C.fg]];
  const room = term.rows - 2 - MARGIN_ROW;
  const lines = tail.slice(-room);
  drawLines(lines, MARGIN_ROW);
  term.text(MARGIN_COL, MARGIN_ROW + lines.length, PROMPT + cursor, C.fg);
}

function drawBoot(now) {
  const intro = [
    ["ascii_tube · browser edition", C.green],
    ["all processing happens on this device; nothing is uploaded.", C.dim],
    ["", C.fg],
  ];
  drawLines(intro, MARGIN_ROW);
  const cursor = Math.floor(now / 530) % 2 === 0 ? "█" : " ";
  term.text(MARGIN_COL, MARGIN_ROW + intro.length, PROMPT + typed + cursor, C.fg);
}

function drawPlay(now) {
  if (!video.videoWidth) {
    term.text(MARGIN_COL, MARGIN_ROW, "loading " + (source ? source.name : "") + " …", C.dim);
    statusBar(now);
    return;
  }
  const g = geometry();
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(video, 0, 0, sampler.width, sampler.height);
  const px = sctx.getImageData(0, 0, sampler.width, sampler.height).data;
  const frame = buildCells(px, g.cols, g.rows, settings.color, g.nlevels, g.dither, g.eq);
  term.cells(g.col0, g.row0, g.cols, g.rows, frame, g.ramp, C.fg);
  if (showHelp) {
    const top = Math.max(0, ((term.rows - 1 - HELP.length) >> 1) - 1);
    for (let r = top; r < top + HELP.length + 2 && r < term.rows - 1; r++) term.fill(0, r, term.cols, [0, 0, 0]);
    drawLines(HELP, top + 1);
  }
  statusBar(now);
}

/* ---- main loop ---------------------------------------------------------- */
let lastBlink = -1;
function frame(now) {
  if (powerStart >= 0 && CRT.power < 1) {
    const T = (now - powerStart) / POWER_MS;
    CRT.power = T >= 1 ? 1 : T;
  }
  if (mode === "boot" && CRT.power >= 1 && now >= typeNext) {
    if (typed.length < typeTarget.length) {
      typed = typeTarget.slice(0, typed.length + 1);
      typeNext = now + 28 + Math.random() * 45;
      dirty = true;
    } else {
      play(SAMPLE);
    }
  }
  const blink = Math.floor(now / 530);
  if (blink !== lastBlink && mode !== "play") { lastBlink = blink; dirty = true; }
  if (mode === "play" && video.currentTime !== lastVideoTime) { lastVideoTime = video.currentTime; dirty = true; }
  if (flashUntil && now >= flashUntil) { flashUntil = 0; dirty = true; }

  if (dirty) {
    dirty = false;
    term.clear();
    if (mode === "boot") drawBoot(now);
    else if (mode === "shell") drawShell(now);
    else if (mode === "play") drawPlay(now);
    term.present();
  }
  crt.draw(now);
  requestAnimationFrame(frame);
}

/* ---- input -------------------------------------------------------------- */
function toggle(key, label) {
  settings[key] = !settings[key];
  saveSettings(); applyTube();
  flash(`${label} ${settings[key] ? "on" : "off"}`);
}
function nudge(key, step, lo, hi, label) {
  settings[key] = Math.min(hi, Math.max(lo, Math.round((settings[key] + step) * 100) / 100));
  saveSettings(); grid = null; dirty = true;
  if (mode === "play") lastCommand = command(source.name);
  flash(`${label} ${settings[key]}`);
}

function handleKey(key) {
  if (mode === "off") {
    if (key === "Enter" || key === " ") powerOn();
    return;
  }
  if (mode === "boot") return;
  if (showHelp && key !== "?" && key !== "h") { showHelp = false; dirty = true; return true; }
  switch (key) {
    case " ":
      if (mode === "play") { video.paused ? video.play().catch(() => {}) : video.pause(); }
      else play(SAMPLE);
      break;
    case "q": case "Escape": if (mode === "play") toShell(); break;
    case "Enter": if (mode === "shell") play(SAMPLE); break;
    case "ArrowRight": if (mode === "play") video.currentTime = Math.min(video.duration || 0, video.currentTime + SEEK_STEP); break;
    case "ArrowLeft": if (mode === "play") video.currentTime = Math.max(0, video.currentTime - SEEK_STEP); break;
    case "o": fileInput.click(); break;
    case "c":
      settings.color = COLOR_MODES[(COLOR_MODES.indexOf(settings.color) + 1) % COLOR_MODES.length];
      saveSettings(); grid = null; dirty = true; flash(`--color ${settings.color}`);
      break;
    case "d": toggle("dither", "--dither"); break;
    case "r": toggle("long", "--long"); break;
    case "i": toggle("invert", "--invert"); break;
    case "l":
      sessionLoop = settings.loop = !sessionLoop;
      saveSettings(); video.loop = sessionLoop;
      flash(`--loop ${sessionLoop ? "on" : "off"}`);
      break;
    case "a":
      settings.audio = !settings.audio; video.muted = !settings.audio;
      flash(`--audio ${settings.audio ? "on" : "off"}`);
      break;
    case "[": nudge("brightness", -0.05, -1, 1, "--brightness"); break;
    case "]": nudge("brightness", +0.05, -1, 1, "--brightness"); break;
    case "{": nudge("contrast", -0.1, 0.1, 4, "--contrast"); break;
    case "}": nudge("contrast", +0.1, 0.1, 4, "--contrast"); break;
    case "g": nudge("gamma", -0.1, 0.1, 4, "--gamma"); break;
    case "G": nudge("gamma", +0.1, 0.1, 4, "--gamma"); break;
    case "-": case "_":
      if (settings.cell > 0) { settings.cell--; saveSettings(); applyTube(); }
      break;
    case "=": case "+":
      if (settings.cell < CELL_SIZES.length - 1) { settings.cell++; saveSettings(); applyTube(); }
      break;
    case "m": toggle("amber", "amber phosphor"); break;
    case "s": toggle("scanlines", "scanlines"); break;
    case "f": {
      const el = document.getElementById("stage");
      if (document.fullscreenElement) document.exitFullscreen?.(); else el.requestFullscreen?.();
      break;
    }
    case "?": case "h":
      if (mode === "play") { showHelp = !showHelp; dirty = true; }
      break;
    default: return false;
  }
  if (mode === "play" && source) lastCommand = command(source.name);
  dirty = true;
  return true;
}

addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const key = /^[A-FH-Z]$/.test(e.key) ? e.key.toLowerCase() : e.key;   // 'G' is its own key
  if (handleKey(key) !== false && [" ", "ArrowLeft", "ArrowRight", "Enter"].includes(e.key)) e.preventDefault();
});
document.querySelectorAll("#hint [data-key]").forEach((b) =>
  b.addEventListener("click", () => handleKey(b.dataset.key)));
fileInput.addEventListener("change", () => { if (mode === "off") powerOn(true); playFile(fileInput.files[0]); fileInput.value = ""; });

const stage = document.getElementById("stage");
["dragenter", "dragover"].forEach((ev) => stage.addEventListener(ev, (e) => {
  e.preventDefault();
  if (mode !== "off") flash("drop to play · stays on this device");
}));
stage.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if (mode === "off") powerOn(true);
  playFile(f);
});

/* ---- boot --------------------------------------------------------------- */
function powerOn(skipIntro = false) {
  if (mode !== "off") return;
  document.getElementById("power")?.remove();
  powerStart = performance.now();
  if (skipIntro) { mode = "shell"; return; }
  mode = "boot";
  typed = "";
  sessionLoop = true;
  typeTarget = command(SAMPLE.name);
  typeNext = powerStart + POWER_MS + 450;
  dirty = true;
}

document.getElementById("power").addEventListener("click", () => powerOn(), { once: true });
applyTube();
requestAnimationFrame(frame);
