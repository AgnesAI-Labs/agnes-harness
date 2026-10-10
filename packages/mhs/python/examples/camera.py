"""A camera that streams a test pattern as H.264 in Agnes MHS (MOS 7). It needs PyAV:

    uv run --extra video python examples/camera.py [ws://127.0.0.1:8800]

Moving bars at 320x240, encoded with x264 for low latency (baseline, no B-frames, no lookahead), at
a constant bitrate the hub can configure within 200-800 kbit/s. Every keyframe carries SPS and PPS;
one comes at least every gop_s, on mhs/keyframe, and after a dropped picture. It passes the Core,
Perception, Streaming and Video profiles of mhs-check:

    uv run python -m agnes_mhs.check --profile core,perception,streaming,video
"""

from __future__ import annotations

import asyncio
import sys
import time
from fractions import Fraction
from typing import Awaitable, Callable

import av

from agnes_mhs import Device

W, H = 320, 240
BARS = b"".join(bytes([luma]) * (W // 8) for luma in (235, 210, 170, 145, 106, 81, 41, 16))


def encoder(kbps: float, hz: float) -> av.CodecContext:
    ctx = av.CodecContext.create("libx264", "w")
    ctx.width, ctx.height, ctx.pix_fmt = W, H, "yuv420p"
    ctx.time_base = Fraction(1, max(1, round(hz)))
    ctx.bit_rate = int(kbps * 1000)
    rate = f"nal-hrd=cbr:vbv-maxrate={int(kbps)}:vbv-bufsize={int(kbps)}:force-cfr=1"
    # Keyframes come when the camera asks for them; repeat-headers puts SPS and PPS in each (VID-3).
    ctx.options = {"preset": "ultrafast", "tune": "zerolatency", "profile": "baseline", "repeat-headers": "1",
                   "forced-idr": "1", "x264-params": f"keyint=infinite:scenecut=0:{rate}"}  # fmt: skip
    return ctx


def pattern(n: int) -> av.VideoFrame:
    frame = av.VideoFrame(W, H, "yuv420p")
    shift = (n * 4) % W
    luma = frame.planes[0]
    luma.update((BARS[shift:] + BARS[:shift] + bytes(luma.line_size - W)) * H)
    for chroma in frame.planes[1:]:
        chroma.update(bytes([128]) * (chroma.line_size * (H // 2)))
    frame.pts = n
    return frame


def make_camera(gop_s: float = 1.0) -> tuple[Device, Callable[[], Awaitable[None]]]:
    """The device, and the loop that captures and encodes; run both."""
    dev = Device("camera-01", "camera", name="Test camera", model="Example Pattern 1")
    video = dev.source(
        "video", "video", "test pattern of moving bars", codec="h264", encoding="rgb", size=[W, H], hz=15,
        fov_deg=[60, 45], mount={"xyz": [0, 0, 0.1], "rpy": [0, 0, 0]}, bitrate_kbps=[200, 800], gop_s=1,
        profile="baseline", default=True,
    )  # fmt: skip

    async def capture() -> None:
        ctx, settings, n, last_key = None, None, 0, 0.0
        while True:
            await asyncio.sleep(1 / (video.hz or 15))
            if not video.wants():
                continue
            if settings != (video.bitrate_kbps, video.hz):
                settings = (video.bitrate_kbps, video.hz)
                ctx = encoder(video.bitrate_kbps or 200, video.hz or 15)
                video.keyframe_requested = True
            t = time.time()
            frame = pattern(n)
            n += 1
            if video.keyframe_requested or t - last_key >= gop_s - 0.5 / (video.hz or 15):
                frame.pict_type = av.video.frame.PictureType.I
            for packet in ctx.encode(frame):
                if video.send({"key": packet.is_keyframe, "w": W, "h": H}, bytes(packet), t=t) and packet.is_keyframe:
                    last_key = t

    return dev, capture


async def main(url: str) -> None:
    dev, capture = make_camera()
    streaming = asyncio.ensure_future(capture())
    try:
        await dev.run(url)
    finally:
        streaming.cancel()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "ws://127.0.0.1:8800"))
