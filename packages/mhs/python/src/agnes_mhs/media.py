"""What mhs-check needs to know about the pictures a device streams (MOS 6 and 7): the NAL units of
an H.264 access unit in Annex B, and decoding with PyAV when it is installed (agnes-mhs[video])."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

try:
    import av
except ImportError:  # decoding is optional; checks that need it report skip
    av = None

NO_DECODER = "no decoder: install agnes-mhs[video] (PyAV) to decode pictures"
B_SLICES = (1, 6)  # slice_type values of B slices


@dataclass
class AccessUnit:
    annex_b: bool  # starts with a start code
    types: list[int] = field(default_factory=list)  # nal_unit_type of every NAL unit
    pictures: int = 0  # primary coded pictures: VCL slices with first_mb_in_slice 0
    b_slices: bool = False

    @property
    def idr(self) -> bool:
        return 5 in self.types

    @property
    def parameter_sets(self) -> bool:
        return 7 in self.types and 8 in self.types


def parse(data: bytes) -> AccessUnit:
    """The NAL units of one Annex B access unit and what its slices are."""
    au = AccessUnit(data.startswith(b"\x00\x00\x01") or data.startswith(b"\x00\x00\x00\x01"))
    for nal in data.split(b"\x00\x00\x01")[1:]:
        nal = nal.rstrip(b"\x00")  # the leading zero of the next four-byte start code
        if not nal:
            continue
        kind = nal[0] & 0x1F
        au.types.append(kind)
        if kind in (1, 5):
            bits = _Bits(_rbsp(nal[1:16]))
            first_mb, slice_type = bits.ue(), bits.ue()
            au.pictures += first_mb == 0
            au.b_slices |= slice_type in B_SLICES
    return au


def _rbsp(data: bytes) -> bytes:
    """Removes emulation prevention bytes (00 00 03 -> 00 00)."""
    return data.replace(b"\x00\x00\x03", b"\x00\x00")


class _Bits:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def bit(self) -> int:
        byte = self.data[self.pos // 8] if self.pos // 8 < len(self.data) else 0
        self.pos += 1
        return (byte >> (7 - (self.pos - 1) % 8)) & 1

    def ue(self) -> int:
        """An unsigned Exp-Golomb code."""
        zeros = 0
        while not self.bit() and zeros < 32:
            zeros += 1
        value = 0
        for _ in range(zeros):
            value = value << 1 | self.bit()
        return (1 << zeros) - 1 + value


def decoder(codec: str = "h264") -> Any:
    """A decoder context, or None without PyAV."""
    return av.CodecContext.create(codec, "r") if av is not None else None


def decode(ctx: Any, data: bytes) -> tuple[list[Any], str | None]:
    """Feeds one packet; returns the frames it produced and an error, if any."""
    try:
        return list(ctx.decode(av.Packet(data))), None
    except av.FFmpegError as e:
        return [], str(e)


def decode_alone(data: bytes, codec: str = "h264") -> tuple[list[Any], str | None]:
    """Decodes one packet with a fresh decoder, flushing it, so the packet must stand on its own."""
    ctx = decoder(codec)
    frames, error = decode(ctx, data)
    if error is None and not frames:
        try:
            frames = list(ctx.decode(None))
        except av.FFmpegError as e:
            error = str(e)
    return frames, error
