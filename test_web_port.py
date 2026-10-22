"""Check the browser port (web/js/ascii.js) against ascii_tube's helpers.

Runs the JS module under Node and compares its output with the Python
originals on the same inputs. Skipped when `node` isn't installed.

Run with `pytest`, or directly: `python test_web_port.py`.
"""
import json
import os
import shutil
import subprocess
import unittest.mock

import numpy as np

import ascii_tube as a

HERE = os.path.dirname(os.path.abspath(__file__))
MODULE = "file://" + os.path.join(HERE, "web", "js", "ascii.js")

NODE_SCRIPT = """
const m = await import(process.argv[1]);
let data = "";
for await (const chunk of process.stdin) data += chunk;
const q = JSON.parse(data);
const out = {
  ramps: [m.DEFAULT_RAMP, m.LONG_RAMP],
  times: q.times.map(m.parseTime),
  dither: Array.from(m.makeDither(q.dither[0], q.dither[1])),
  plain: q.plain.map(([n, vs]) => vs.map((v) => m.quantize(v, n, null))),
  dithered: q.dithered.map(([n, vs, d]) => vs.map((v, i) => m.quantize(v, n, d[i]))),
  lum: q.rgb.map(([r, g, b]) => m.luma(r, g, b)),
  x256: q.rgb.map(([r, g, b]) => m.rgbTo256(r, g, b, m.luma(r, g, b))),
  dims: q.dims.map(([w, h, wo, ca, tc, tl]) => m.computeDims(w, h, wo, ca, tc, tl)),
};
process.stdout.write(JSON.stringify(out));
"""


def run_node(query):
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", NODE_SCRIPT, MODULE],
        input=json.dumps(query), capture_output=True, text=True, check=True,
    )
    return json.loads(proc.stdout)


def py_dims(w, h, wo, ca, tc, tl):
    with unittest.mock.patch.object(a.shutil, "get_terminal_size",
                                    return_value=os.terminal_size((tc, tl))):
        return list(a.compute_dims(w, h, wo, ca))


def test_web_port_matches_python():
    if shutil.which("node") is None:
        try:
            import pytest
            pytest.skip("node not installed")
        except ImportError:
            return

    rng = np.random.default_rng(7)
    rgb = rng.integers(0, 256, size=(300, 3)).astype(np.uint16)
    rgb[:32] = [[i * 8] * 3 for i in range(32)]           # neutrals -> grey ramp
    vals = np.arange(256, dtype=np.uint8)
    swirl = np.array([(i * 37) % 256 for i in range(256)], dtype=np.uint8).reshape(16, 16)
    dmap = a.make_dither(16, 16)
    dims = [(1920, 1080, 0, 0.5, 80, 24), (1920, 1080, 0, 0.5, 200, 50),
            (854, 480, 0, 8 / 12, 160, 80), (640, 480, 0, 8 / 12, 213, 106),
            (1080, 1920, 0, 8 / 12, 160, 80), (0, 0, 0, 0.5, 120, 40),
            (1920, 1080, 100, 0.5, 80, 24), (1920, 800, 0, 6 / 9, 213, 106),
            (1000, 500, 0, 0.5, 81, 30)]
    times = ["", "  ", "90", "1:30", "01:02:03", "2.5", "1:", ":30", "abc", "1:2:3:4", "1: 30"]

    js = run_node({
        "times": times,
        "dither": [5, 7],
        "plain": [[n, vals.tolist()] for n in (9, 69)],
        "dithered": [[n, swirl.reshape(-1).tolist(), dmap.reshape(-1).tolist()] for n in (9, 69)],
        "rgb": rgb.tolist(),
        "dims": dims,
    })

    assert js["ramps"] == [a.DEFAULT_RAMP, a.LONG_RAMP]
    assert js["times"] == [a.parse_time(t) for t in times]
    assert js["dither"] == a.make_dither(5, 7).reshape(-1).tolist()
    for n, got in zip((9, 69), js["plain"]):
        assert got == a.quantize(vals, n, None).tolist()
    for n, got in zip((9, 69), js["dithered"]):
        assert got == a.quantize(swirl, n, dmap).reshape(-1).tolist()
    r, g, b = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    lum = (r * 77 + g * 150 + b * 29) >> 8
    assert js["lum"] == lum.tolist()
    assert js["x256"] == a._rgb_to_256(r, g, b, lum).tolist()
    assert js["dims"] == [py_dims(*d) for d in dims]


if __name__ == "__main__":
    test_web_port_matches_python()
    print("ok test_web_port_matches_python")
