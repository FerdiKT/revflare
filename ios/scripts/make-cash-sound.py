#!/usr/bin/env python3
"""Synthesizes the "cha-ching" push sound (cash.caf, about 1.2 s).

    python3 scripts/make-cash-sound.py /tmp/cash.wav
    afconvert -f caff -d LEI16@44100 -c 1 /tmp/cash.wav Revflare/Resources/cash.caf

"cha": a short mechanical drawer click + coin rattle (filtered noise bursts); "ching": two bright bell strikes built
from inharmonic partials with exponential decay. Standard library only.
"""

import math
import random
import struct
import sys
import wave

RATE = 44100
DUR = 1.25
N = int(RATE * DUR)
random.seed(7)
buf = [0.0] * N


def add(start, samples):
    i0 = int(start * RATE)
    for i, v in enumerate(samples):
        j = i0 + i
        if 0 <= j < N:
            buf[j] += v


def noise_burst(length, decay, gain, lowpass=0.35):
    out, y = [], 0.0
    for i in range(int(length * RATE)):
        t = i / RATE
        y += lowpass * (random.uniform(-1, 1) - y)
        out.append(y * gain * math.exp(-t / decay))
    return out


def click(gain):
    # Drawer latch: a damped low thump plus a noise transient.
    out = []
    for i in range(int(0.05 * RATE)):
        t = i / RATE
        out.append(gain * (0.8 * math.sin(2 * math.pi * 180 * t) * math.exp(-t / 0.012) + 0.5 * random.uniform(-1, 1) * math.exp(-t / 0.004)))
    return out


def bell(f0, length, gain, decay):
    # Inharmonic partials of a small bell (ratios after Rossing), higher ones decay faster.
    partials = [(1.0, 1.0), (2.76, 0.55), (5.40, 0.30), (8.93, 0.16), (13.34, 0.08)]
    out = []
    for i in range(int(length * RATE)):
        t = i / RATE
        attack = min(1.0, t / 0.002)
        v = 0.0
        for ratio, amp in partials:
            v += amp * math.sin(2 * math.pi * f0 * ratio * t) * math.exp(-t * ratio ** 0.6 / decay)
        out.append(gain * attack * v)
    return out


def coins(start, count, spread, gain):
    for _ in range(count):
        t = start + random.uniform(0, spread)
        f = random.uniform(3200, 5200)
        g = gain * random.uniform(0.4, 1.0)
        add(t, [g * math.sin(2 * math.pi * f * (i / RATE)) * math.exp(-(i / RATE) / 0.018) for i in range(int(0.06 * RATE))])


# "cha"
add(0.00, click(0.55))
add(0.005, noise_burst(0.09, 0.025, 0.35))
coins(0.02, 9, 0.12, 0.10)
# "ching" (two strikes, the second a fifth higher and brighter)
add(0.17, bell(1318.5, 1.05, 0.30, 0.42))
add(0.21, bell(1975.5, 1.0, 0.26, 0.38))
coins(0.20, 6, 0.25, 0.05)

# Gentle high-shelf softening (one-pole low-pass mixed in) and a fade-out tail.
y, soft = 0.0, []
for i, v in enumerate(buf):
    y += 0.55 * (v - y)
    s = 0.6 * v + 0.4 * y
    t = i / RATE
    if t > DUR - 0.25:
        s *= max(0.0, (DUR - t) / 0.25)
    soft.append(s)

peak = max(abs(v) for v in soft) or 1.0
scale = 0.85 / peak
out = sys.argv[1] if len(sys.argv) > 1 else "cash.wav"
with wave.open(out, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(RATE)
    w.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, v * scale)) * 32767)) for v in soft))
print(f"wrote {out} ({DUR:.2f} s)")
