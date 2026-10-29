"""The YAML frontmatter of Claude Code's skills (``SKILL.md``) and subagents (``agents/*.md``), read for
the keys the fence needs: ``name``, ``hooks`` and ``mcpServers``. Claude Code takes hooks from it in the
same format as a settings file's, and MCP servers as ``.mcp.json`` names them.

Only the YAML that frontmatter uses is read: block mappings and sequences, plain and quoted scalars,
block scalars (``|``, ``>``) and flow collections (``[a, b]``, ``{ a: b }``). Each top-level key is read
on its own, so a description written in YAML this doesn't read costs nothing; a key whose value can't be
read is ``UNREADABLE``, and its reader decides what that means (the fence assumes the worst of it). The
twin of frontmatter.ts in @shadowlap/adapters, held to the same cases.
"""

from __future__ import annotations

import re
from typing import Any, Optional

#: A top-level key whose value couldn't be read.
UNREADABLE = object()


class _YamlError(ValueError):
    pass


def frontmatter(text: str) -> Optional[dict[str, Any]]:
    """The top-level keys of a file's frontmatter, each with its value (or ``UNREADABLE``), or None when
    the file has no frontmatter (it doesn't start with a ``---`` line, or nothing closes it)."""
    lines = re.split(r"\r?\n", text[1:] if text.startswith("\ufeff") else text)
    if not lines or lines[0].rstrip() != "---":
        return None
    close = next((i for i, line in enumerate(lines) if i > 0 and line.rstrip() in ("---", "...")), -1)
    if close < 0:
        return None
    entries: list[tuple[str, str, list[str]]] = []
    for line in lines[1:close]:
        top = _split_key(_strip_comment(line)) if line and not line[0].isspace() and not line.startswith("#") and not line.startswith("-") else None
        if top:
            entries.append((top[0], top[1], []))
        elif entries:
            entries[-1][2].append(line)
    out: dict[str, Any] = {}
    for key, rest, block in entries:
        try:
            reader = _Reader(block)
            value = reader.value(rest, 0)
            reader.end()
            out[key] = value
        except (_YamlError, ValueError, IndexError):
            out[key] = UNREADABLE
    return out


def _split_key(text: str) -> Optional[tuple[str, str]]:
    """``key: rest`` or ``key:``, the key plain or quoted; None for a line that holds no key."""
    t = text.strip()
    if not t or (re.match(r"^[-?\[\]{}#&*!|>%@`,]", t) and not re.match(r"^-\S", t)):
        return None
    if t[0] in "\"'":
        value, end = _quoted(t, 0)
        after = t[end:].lstrip()
        if not after.startswith(":") or (len(after) > 1 and not after[1].isspace()):
            return None
        return value, after[1:].strip()
    m = re.search(r":(\s|$)", t)
    if not m:
        return None
    return t[: m.start()].strip(), t[m.start() + 1 :].strip()


def _strip_comment(line: str) -> str:
    """The line without a comment: a ``#`` at its start or after a space, outside quotes."""
    quote: Optional[str] = None
    i = 0
    while i < len(line):
        c = line[i]
        if quote == '"':
            if c == "\\":
                i += 1
            elif c == '"':
                quote = None
        elif quote == "'":
            if c == "'" and i + 1 < len(line) and line[i + 1] == "'":
                i += 1
            elif c == "'":
                quote = None
        elif c in "\"'" and (i == 0 or re.match(r"[\s\[{,:-]", line[i - 1])):
            quote = c
        elif c == "#" and (i == 0 or line[i - 1].isspace()):
            return line[:i].rstrip()
        i += 1
    return line.rstrip()


_SIMPLE = {"n": "\n", "t": "\t", "r": "\r", "0": "\0", '"': '"', "\\": "\\", "/": "/", " ": " ", "e": "\x1b", "b": "\b", "f": "\f"}


def _quoted(text: str, at: int) -> tuple[str, int]:
    """A quoted scalar starting at ``at``: its value and where it ends. Raises when nothing closes it."""
    q = text[at]
    out: list[str] = []
    i = at + 1
    while i < len(text):
        c = text[i]
        if q == "'":
            if c == "'" and i + 1 < len(text) and text[i + 1] == "'":
                out.append("'")
                i += 2
                continue
            if c == "'":
                return "".join(out), i + 1
            out.append(c)
            i += 1
            continue
        if c == '"':
            return "".join(out), i + 1
        if c != "\\":
            out.append(c)
            i += 1
            continue
        i += 1
        e = text[i] if i < len(text) else None
        if e is not None and e in _SIMPLE:
            out.append(_SIMPLE[e])
        elif e in ("x", "u", "U"):
            n = {"x": 2, "u": 4, "U": 8}[e]
            hex_digits = text[i + 1 : i + 1 + n]
            if len(hex_digits) != n or not re.fullmatch(r"[0-9a-fA-F]+", hex_digits):
                raise _YamlError("bad escape")
            out.append(chr(int(hex_digits, 16)))
            i += n
        else:
            raise _YamlError("bad escape")
        i += 1
    raise _YamlError("unclosed quote")


def _plain(text: str) -> Any:
    """A plain scalar: true, false and null as YAML reads them, anything else the text itself."""
    t = text.strip()
    if t in ("true", "True", "TRUE"):
        return True
    if t in ("false", "False", "FALSE"):
        return False
    if t in ("", "null", "Null", "NULL", "~"):
        return None
    if t[0] in "&*!":
        raise _YamlError("anchors, aliases and tags are not read")
    return t


def _flow(text: str, at: int) -> tuple[Any, int]:
    """A flow collection or scalar, ``[a, "b", { c: d }]``, read from ``text`` at ``at``."""

    def skip(i: int) -> int:
        while i < len(text) and text[i].isspace():
            i += 1
        return i

    i = skip(at)
    c = text[i] if i < len(text) else ""
    if c in ("[", "{"):
        is_list = c == "["
        close = "]" if is_list else "}"
        items: list[Any] = []
        mapping: dict[str, Any] = {}
        i = skip(i + 1)
        while i >= len(text) or text[i] != close:
            if i >= len(text):
                raise _YamlError("unclosed flow collection")
            key, i = _flow(text, i)
            i = skip(i)
            if not is_list or (i < len(text) and text[i] == ":"):
                if i >= len(text) or text[i] != ":":
                    raise _YamlError("a flow mapping entry needs a value")
                value, i = _flow(text, i + 1)
                mapping[str(key)] = value
                if is_list:
                    items.append({str(key): value})
                i = skip(i)
            else:
                items.append(key)
            if i < len(text) and text[i] == ",":
                i = skip(i + 1)
            elif i >= len(text) or text[i] != close:
                raise _YamlError("expected , in a flow collection")
        return (items if is_list else mapping), i + 1
    if c in ("'", '"'):
        return _quoted(text, i)
    j = i
    while j < len(text) and text[j] not in ",]}" and not (text[j] == ":" and (j + 1 >= len(text) or text[j + 1] in " \t,]}")):
        j += 1
    return _plain(text[i:j]), j


def _is_dash(text: str) -> bool:
    return text == "-" or text.startswith("- ")


class _Line:
    __slots__ = ("indent", "raw", "text")

    def __init__(self, indent: int, text: str, raw: str) -> None:
        self.indent = indent
        self.text = text
        self.raw = raw


class _Reader:
    """Reads one value from a block of lines, as YAML's block context does."""

    def __init__(self, raw: list[str]) -> None:
        self.lines: list[_Line] = []
        for r in raw:
            indent = len(r) - len(r.lstrip(" "))
            if r[indent : indent + 1] == "\t":
                raise _YamlError("a tab indents the line")
            self.lines.append(_Line(indent, _strip_comment(r[indent:]), r))
        self.i = 0

    def _peek(self) -> Optional[_Line]:
        while self.i < len(self.lines) and self.lines[self.i].text == "":
            self.i += 1
        return self.lines[self.i] if self.i < len(self.lines) else None

    def end(self) -> None:
        if self._peek():
            raise _YamlError("a line left over")

    def value(self, rest: str, indent: int) -> Any:
        """The value after a key or a dash (``rest``), its block below it, more indented than ``indent``."""
        if rest == "":
            nxt = self._peek()
            if not nxt:
                return None
            if nxt.indent > indent:
                return self._node(nxt.indent)
            # A mapping's value may be a sequence at the key's own indentation.
            if nxt.indent == indent and _is_dash(nxt.text):
                return self._sequence(indent)
            return None
        if re.fullmatch(r"[|>][-+0-9]*", rest):
            return self._block_scalar(indent, rest[0] == "|")
        if rest[0] in "[{":
            text = rest
            # A flow collection may go on over the lines below it.
            while True:
                try:
                    value, end = _flow(text, 0)
                    if text[end:].strip():
                        raise _YamlError("text after a flow collection")
                    return value
                except (_YamlError, IndexError):
                    nxt = self._peek()
                    if not nxt or nxt.indent <= indent:
                        raise
                    text += " " + nxt.text
                    self.i += 1
        if rest[0] in "\"'":
            value, end = _quoted(rest, 0)
            if rest[end:].strip():
                raise _YamlError("text after a quoted scalar")
            return value
        # A plain scalar may go on over the lines below it.
        text = rest
        nxt = self._peek()
        while nxt and nxt.indent > indent and not _split_key(nxt.text) and not _is_dash(nxt.text):
            text += " " + nxt.text
            self.i += 1
            nxt = self._peek()
        return _plain(text)

    def _node(self, indent: int) -> Any:
        line = self._peek()
        assert line is not None
        if _is_dash(line.text):
            return self._sequence(indent)
        if _split_key(line.text):
            return self._mapping(indent)
        self.i += 1
        return self.value(line.text, indent - 1)

    def _mapping(self, indent: int) -> dict[str, Any]:
        out: dict[str, Any] = {}
        line = self._peek()
        while line and line.indent == indent:
            kv = _split_key(line.text)
            if not kv:
                raise _YamlError("expected a key")
            self.i += 1
            out[kv[0]] = self.value(kv[1], indent)
            line = self._peek()
        if line and line.indent > indent:
            raise _YamlError("a line indented past its mapping")
        return out

    def _sequence(self, indent: int) -> list[Any]:
        out: list[Any] = []
        line = self._peek()
        while line and line.indent == indent and _is_dash(line.text):
            rest = line.text[1:].lstrip()
            if rest and _split_key(rest):
                # ``- key: value`` starts a mapping whose keys line up after the dash.
                col = indent + len(line.text) - len(rest)
                self.lines[self.i] = _Line(col, rest, " " * col + rest)
                out.append(self._mapping(col))
            else:
                self.i += 1
                out.append(self.value(rest, indent))
            line = self._peek()
        return out

    def _block_scalar(self, indent: int, literal: bool) -> str:
        taken: list[str] = []
        width: Optional[int] = None
        while self.i < len(self.lines):
            line = self.lines[self.i]
            if line.raw.strip() == "":
                taken.append("")
                self.i += 1
                continue
            if line.indent <= indent:
                break
            if width is None:
                width = line.indent
            taken.append(line.raw[min(width, line.indent) :])
            self.i += 1
        while taken and taken[-1] == "":
            taken.pop()
        return "\n".join(taken) if literal else " ".join(taken)
