"""Kernel-side surface of the Agnes host bridge.

Every call here becomes one JSON-RPC frame on the `agnes.bridge` comm target and comes
back through the harness: approval, sandbox and accounting all apply. A governed refusal
raises BridgeError with a numeric code (1001-1005) and is catchable - it does not kill the cell.
"""

from typing import Any

class tools:
    """Dynamic namespace: attributes are resolved to bridge.tools.invoke at call time.

    The generated SDK block in the system prompt lists what is available this turn.
    """
    def __getattr__(self, name: str) -> Any: ...

async def spawn(task: str, **opts: Any) -> dict[str, Any]:
    """Start a child agent. Returns a handle; the answer arrives through collect()."""

async def fork(question: str, **opts: Any) -> str:
    """Ask a byte-identical copy of this context one question and get the text back."""

async def collect(child_key: str, *, wait: bool = False) -> dict[str, Any]:
    """Read a child's status, optionally waiting for it to finish."""

class artifacts:
    @staticmethod
    async def put(data: bytes, *, mime: str | None = None, name: str | None = None) -> dict[str, Any]: ...
    @staticmethod
    async def get(ref: dict[str, Any]) -> bytes: ...

class plan:
    @staticmethod
    async def set(items: list[dict[str, Any]]) -> int: ...

class harness:
    @staticmethod
    async def propose(proposal: dict[str, Any]) -> dict[str, Any]:
        """Propose a change to prompts, memory, skills or subagent specs. Proposals are
        reviewed by the harness; there is no direct write path from the kernel."""

async def log(level: str, message: str) -> None: ...

class BridgeError(Exception):
    code: int
    message: str
