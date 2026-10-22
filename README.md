# ascii_tube

Render a YouTube or local video as ASCII in the terminal — monochrome by
default, with optional colour modes, interactive playback controls, and audio.

```
ascii_tube.py <URL|file> [options]
```

Install as a command (`ascii-tube`) with `pip install .` (or `pipx install .`).

## In the browser

**Live: https://allthemalware.github.io/ascii_tube/**

The same renderer on an emulated CRT terminal: power the tube on and it plays a
short sample clip; drop in (or press `O` to open) any video of your own.

> **Your footage never leaves your device.** All decoding and rendering happens
> in the page, on your machine. Nothing is uploaded, copied or sent anywhere:
> there is no server behind it and no tracking. The only things the page
> fetches are its own files and the sample clip.

It keeps the terminal tool's behaviour: the character ramps, the four colour
modes, dithering, picture tuning and the playback keys all work the same, and
the status bar shows the equivalent `ascii-tube` command for what's on screen.

| key       | action                 | key     | action                          |
|-----------|------------------------|---------|---------------------------------|
| `space`   | pause / resume         | `c`     | cycle `--color`                 |
| `q`/`Esc` | stop                   | `d`     | `--dither`                      |
| `←` / `→` | seek ∓5 seconds        | `r`     | `--long` ramp                   |
| `o`       | open a video file      | `i`     | `--invert`                      |
| `enter`   | play the sample        | `l`     | `--loop`                        |
| `?`       | help                   | `a`     | `--audio` (muted by default)    |
| `-` / `=` | smaller / larger text  | `[` `]` | `--brightness` ∓0.05            |
| `m`       | amber phosphor         | `{` `}` | `--contrast` ∓0.1               |
| `s`       | scanlines              | `g` `G` | `--gamma` ∓0.1                  |
| `f`       | fullscreen             |         |                                 |

YouTube links need the terminal version: browsers can't fetch those streams.
Anything the browser can decode plays (H.264 `.mp4` and `.webm` everywhere).

The browser build is plain static files in `web/`, no build step. Run it
locally with any static server (ES modules don't load over `file://`):

```
python3 -m http.server -d web 8000    # then open http://localhost:8000/
```

Pushes to `main` deploy `web/` to GitHub Pages via
`.github/workflows/pages.yml`. All paths are relative, so it works unchanged
behind a custom domain.

## Webcam in the browser (ascii-cam)

A zero-install **browser build** of `ascii_cam` — live webcam, video file, or
screen share to ASCII, with the olive-green theme, historic display palettes,
several gradient maps, and cool-retro-term-style CRT effects, running entirely
client-side — lives in its own repository:
**[ascii-cam](https://github.com/allthemalware/ascii-cam)**
(deployed to GitHub Pages).

## Colour

Output is monochrome by default. Add colour with:

```
--color 256          # xterm 256-colour palette (broad terminal support)
--color truecolor    # 24-bit RGB (modern terminals; --colour also accepted)
--color halfblock    # '▀' with fg=top / bg=bottom pixel -> 2x vertical detail
```

In the ramp modes (`256`/`truecolor`) the character is chosen by the pixel's
luminance, so the picture's structure reads identically in every mode — colour
just tints each cell. Escape codes are emitted only when the colour changes from
the previous cell, so flat regions stay cheap to draw. `halfblock` packs two
vertical pixels into every cell (foreground + background) for the highest
fidelity; it uses 24-bit colour.

## Picture tuning

```
--dither             # ordered (Bayer) dithering to reduce gradient banding
--brightness N       # ffmpeg eq brightness, -1..1 (default 0)
--contrast N         # ffmpeg eq contrast (default 1)
--gamma N            # ffmpeg eq gamma (default 1)
--invert             # invert brightness (light-background terminals)
--long               # 70-level character ramp for finer gradation
```

## Playback

In a terminal, playback is interactive:

| key            | action            |
|----------------|-------------------|
| `space`        | pause / resume    |
| `q` / `Esc`    | quit              |
| `←` / `→`      | seek ∓5 seconds   |

The window may be resized mid-play (the grid re-fits automatically). When the
terminal can't keep up, late frames are **dropped** rather than played in slow
motion, so video stays in sync with audio and wall-clock time.

```
--start [hh:]mm:ss   # begin at a timestamp (also accepts plain seconds)
--loop               # restart from the beginning when playback ends
--frames N           # stop after N frames (1 = a single still)
--diff               # redraw only changed cells (good for mostly-static content)
```

## Audio

Audio is muted by default. Pass `--audio` to play sound through a parallel
`ffplay` chain — a separate `bestaudio` stream for URLs, or the file's own
audio track for local files. Override the URL audio stream selector with
`--audio-format` (default `ba/bestaudio/b`).

Audio plays in its own process and tracks the wall clock independently of the
video loop, so the two stay within a roughly fixed offset rather than drifting
apart over time.

## Dependencies

yt-dlp, ffmpeg (+ ffprobe), numpy; `ffplay` is additionally required only when
`--audio` is used.

## Live webcam (ascii_cam)

`ascii_cam.py` is the live-capture sibling: it renders a webcam feed as ASCII in
real time, sharing all of ascii_tube's rendering (ramps, colour modes, dither,
half-block, `--diff`). Frames come straight off the camera via ffmpeg's platform
capture backend (`v4l2` on Linux, `avfoundation` on macOS, `dshow` on Windows).

> There is also a zero-install **browser build** of ascii_cam with retro palettes
> and CRT effects — see the [ascii-cam](https://github.com/allthemalware/ascii-cam) repo.

```
ascii_cam.py [options]              # default camera, monochrome
ascii_cam.py --color halfblock      # a colour terminal mirror
ascii_cam.py --list                 # show available capture devices
ascii_cam.py --test                 # synthetic test pattern (no webcam needed)
```

Install the `ascii-cam` command alongside `ascii-tube` with `pip install .`.

The colour/tuning flags (`--color`, `--dither`, `--brightness`, `--contrast`,
`--gamma`, `--invert`, `--long`, `--chars`, `--width`, `--char-aspect`,
`--diff`) behave exactly as they do for ascii_tube. Capture-specific options:

```
-d, --device DEV     # camera (default /dev/video0; e.g. 0 on macOS)
--fps N              # target capture/render rate (default 30)
--video-size WxH     # request a capture resolution, e.g. 640x480
--no-mirror          # don't horizontally mirror (mirroring is on by default)
--frames N           # stop after N frames (1 = a single snapshot)
```

Because the feed is live there is no seeking, looping or start offset. To keep
latency low the loop always renders the **newest** available frame, dropping any
backlog. Interactive controls in a terminal:

| key            | action               |
|----------------|----------------------|
| `space`        | freeze / resume      |
| `m`            | toggle mirror        |
| `q` / `Esc`    | quit                 |

Dependencies: ffmpeg (+ ffprobe), numpy.

## Tests

```
pytest                 # or: python test_ascii_tube.py
```

`test_web_port.py` checks the browser port (`web/js/ascii.js`) against the
Python helpers on the same inputs; it needs `node` and is skipped without it.
