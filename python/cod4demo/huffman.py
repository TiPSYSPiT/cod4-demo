"""Static Huffman coding used by CoD4 network messages and demos.

CoD4 compresses every server message with a *static* Huffman code. The engine
builds the code tree at start-up by feeding the adaptive FGK/Vitter algorithm
(the Quake 3 ``huffman.c``) with the symbol frequency table ``msg_hData``,
inserting the symbols in ascending order of frequency (``Init_COD4``). The
shape of the resulting tree depends on that exact insertion order, so the
builder below is a faithful port of the engine code.

Building the tree takes a few seconds in pure Python (about two million node
increments), so the resulting code table is shipped pre-computed in
``_huffman_table.py``. ``build_codes()`` rebuilds it from scratch and
``selftest()`` checks that both agree.
"""

from __future__ import annotations

import hashlib

__all__ = ["decompress", "build_codes", "selftest", "MSG_HDATA"]

#: Symbol frequencies of the CoD4 engine (``msg_hData``).
MSG_HDATA = (
    274054, 68777, 40460, 40266, 48059, 39006, 48630, 27692, 17712, 15439, 12386, 10758,
    9420, 9979, 9346, 15256, 13184, 14319, 7750, 7221, 6095, 5666, 12606, 7263, 7322, 5807,
    11628, 6199, 7826, 6349, 7698, 9656, 28968, 5164, 13629, 6058, 4745, 4519, 5199, 4807,
    5323, 3433, 3455, 3563, 6979, 5229, 5002, 4423, 14108, 13631, 11908, 11801, 10261, 7635,
    7215, 7218, 9353, 6161, 5689, 4649, 5026, 5866, 8002, 10534, 15381, 8874, 11798, 7199,
    12814, 6103, 4982, 5972, 6779, 4929, 5333, 3503, 4345, 6098, 14117, 16440, 6446, 3062,
    4695, 3085, 4198, 4013, 3878, 3414, 5514, 4092, 3261, 4740, 4544, 3127, 3385, 7688,
    11126, 6417, 5297, 4529, 6333, 4210, 7056, 4658, 6190, 3512, 2843, 3479, 9369, 5203,
    4980, 5881, 7509, 4292, 6097, 5492, 4648, 2996, 4988, 4163, 6534, 4001, 4342, 4488,
    6039, 4827, 7112, 8654, 26712, 8688, 9677, 9368, 7209, 3399, 4473, 4677, 11087, 4094,
    3404, 4176, 6733, 3702, 11420, 4867, 5968, 3475, 3722, 3560, 4571, 2720, 3189, 3099,
    4595, 4044, 4402, 3889, 4989, 3186, 3153, 5387, 8020, 3322, 3775, 2886, 4191, 2879,
    3110, 2576, 3693, 2436, 4935, 3017, 3538, 5688, 3444, 3410, 9170, 4708, 3425, 3273,
    3684, 4564, 6957, 4817, 5224, 3285, 3143, 4227, 5630, 6053, 5851, 6507, 13692, 8270,
    8260, 5583, 7568, 4082, 3984, 4574, 6440, 3533, 2992, 2708, 5190, 3889, 3799, 4582,
    6020, 3464, 4431, 3495, 2906, 2243, 3856, 3321, 8759, 3928, 2905, 3875, 4382, 3885,
    5869, 6235, 10685, 4433, 4639, 4305, 4683, 2849, 3379, 4684, 5477, 4127, 3853, 3515,
    4913, 3601, 5237, 6617, 9019, 4857, 4112, 5180, 5998, 4925, 4986, 6365, 7930, 5948,
    8085, 7732, 8643, 8901, 9653, 32647,
)

_NYT = 256          # "not yet transmitted" pseudo symbol
_INTERNAL = 257     # marker for internal nodes


# ---------------------------------------------------------------------------
# Tree construction (port of Huff_addRef / increment / swap from huffman.c)
# ---------------------------------------------------------------------------

def build_codes(freq=MSG_HDATA) -> dict[int, tuple[int, int]]:
    """Build the CoD4 Huffman tree and return ``{symbol: (code, length)}``.

    ``code`` holds the bits in reading order, first bit in bit 0 (the stream
    is read LSB first within each byte).
    """
    freq = list(freq)
    if len(freq) != 256:
        raise ValueError("the frequency table needs 256 entries")

    size = 768
    left = [-1] * size
    right = [-1] * size
    parent = [-1] * size
    nxt = [-1] * size
    prv = [-1] * size
    head = [-1] * size          # index into ptrs
    weight = [0] * size
    symbol = [0] * size
    ptrs = [-1] * size          # node pointer slots ("nodePtrs")
    free_slots: list[int] = []
    loc = [-1] * 258
    state = {"bloc_node": 0, "bloc_ptrs": 0, "tree": 0}

    def get_ppnode() -> int:
        if free_slots:
            return free_slots.pop()
        i = state["bloc_ptrs"]
        state["bloc_ptrs"] += 1
        return i

    def swap(a: int, b: int) -> None:
        pa, pb = parent[a], parent[b]
        if pa >= 0:
            if left[pa] == a:
                left[pa] = b
            else:
                right[pa] = b
        else:
            state["tree"] = b
        if pb >= 0:
            if left[pb] == b:
                left[pb] = a
            else:
                right[pb] = a
        else:
            state["tree"] = a
        parent[a], parent[b] = pb, pa

    def swaplist(a: int, b: int) -> None:
        nxt[a], nxt[b] = nxt[b], nxt[a]
        prv[a], prv[b] = prv[b], prv[a]
        if nxt[a] == a:
            nxt[a] = b
        if nxt[b] == b:
            nxt[b] = a
        if nxt[a] >= 0:
            prv[nxt[a]] = a
        if nxt[b] >= 0:
            prv[nxt[b]] = b
        if prv[a] >= 0:
            nxt[prv[a]] = a
        if prv[b] >= 0:
            nxt[prv[b]] = b

    def increment(node: int) -> None:
        # The engine recurses from the node up to the root and performs a
        # post-processing step on the way back; done iteratively here.
        chain: list[int] = []
        while node >= 0:
            if nxt[node] >= 0 and weight[nxt[node]] == weight[node]:
                lnode = ptrs[head[node]]
                if lnode != parent[node]:
                    swap(lnode, node)
                swaplist(lnode, node)
            if prv[node] >= 0 and weight[prv[node]] == weight[node]:
                ptrs[head[node]] = prv[node]
            else:
                ptrs[head[node]] = -1
                free_slots.append(head[node])
            weight[node] += 1
            if nxt[node] >= 0 and weight[nxt[node]] == weight[node]:
                head[node] = head[nxt[node]]
            else:
                head[node] = get_ppnode()
                ptrs[head[node]] = node
            chain.append(node)
            node = parent[node]
        for nd in reversed(chain):
            p = parent[nd]
            if p >= 0 and prv[nd] == p:
                swaplist(nd, p)
                if ptrs[head[nd]] == nd:
                    ptrs[head[nd]] = p

    lhead = 0
    state["bloc_node"] = 1
    state["tree"] = lhead
    symbol[lhead] = _NYT
    loc[_NYT] = lhead

    def add_ref(ch: int) -> None:
        if loc[ch] >= 0:
            increment(loc[ch])
            return
        tnode = state["bloc_node"]
        tnode2 = tnode + 1
        state["bloc_node"] += 2

        symbol[tnode2] = _INTERNAL
        weight[tnode2] = 1
        nxt[tnode2] = nxt[lhead]
        if nxt[lhead] >= 0:
            prv[nxt[lhead]] = tnode2
            if weight[nxt[lhead]] == 1:
                head[tnode2] = head[nxt[lhead]]
            else:
                head[tnode2] = get_ppnode()
                ptrs[head[tnode2]] = tnode2
        else:
            head[tnode2] = get_ppnode()
            ptrs[head[tnode2]] = tnode2
        nxt[lhead] = tnode2
        prv[tnode2] = lhead

        symbol[tnode] = ch
        weight[tnode] = 1
        nxt[tnode] = nxt[lhead]
        if nxt[lhead] >= 0:
            prv[nxt[lhead]] = tnode
            if weight[nxt[lhead]] == 1:
                head[tnode] = head[nxt[lhead]]
            else:
                # the engine really stores tnode2 here
                head[tnode] = get_ppnode()
                ptrs[head[tnode]] = tnode2
        else:
            head[tnode] = get_ppnode()
            ptrs[head[tnode]] = tnode
        nxt[lhead] = tnode
        prv[tnode] = lhead
        left[tnode] = right[tnode] = -1

        if parent[lhead] >= 0:
            if left[parent[lhead]] == lhead:
                left[parent[lhead]] = tnode2
            else:
                right[parent[lhead]] = tnode2
        else:
            state["tree"] = tnode2
        right[tnode2] = tnode
        left[tnode2] = lhead
        parent[tnode2] = parent[lhead]
        parent[lhead] = tnode2
        parent[tnode] = tnode2
        loc[ch] = tnode
        increment(parent[tnode2])

    # Init_COD4: insert every symbol freq[i] times, lowest frequency first
    done = [False] * 256
    while True:
        lowest, best = -1, None
        for i in range(256):
            if not done[i] and (best is None or freq[i] < best):
                lowest, best = i, freq[i]
        if lowest < 0:
            break
        for _ in range(best):
            add_ref(lowest)
        done[lowest] = True

    codes: dict[int, tuple[int, int]] = {}
    stack = [(state["tree"], 0, 0)]
    while stack:
        node, code, length = stack.pop()
        if symbol[node] != _INTERNAL:
            if symbol[node] != _NYT:
                codes[symbol[node]] = (code, length)
            continue
        stack.append((left[node], code, length + 1))                   # bit 0
        stack.append((right[node], code | (1 << length), length + 1))  # bit 1
    return codes


def fingerprint(codes: dict[int, tuple[int, int]]) -> str:
    canon = ",".join(f"{s}:{codes[s][0]}:{codes[s][1]}" for s in sorted(codes))
    return hashlib.sha256(canon.encode()).hexdigest()


# ---------------------------------------------------------------------------
# Decoding
# ---------------------------------------------------------------------------

_LUT: list[int] | None = None
_LUT_BITS = 0


def _init_lut() -> None:
    global _LUT, _LUT_BITS
    from ._huffman_table import CODES
    maxlen = max(length for _code, length in CODES.values())
    size = 1 << maxlen
    lut = [0] * size
    for sym, (code, length) in CODES.items():
        packed = (sym << 5) | length
        for idx in range(code, size, 1 << length):
            lut[idx] = packed
    _LUT, _LUT_BITS = lut, maxlen


def decompress(data: bytes | bytearray | memoryview, start: int = 0,
               length: int | None = None, max_out: int = 0x20000) -> bytes:
    """Huffman-decode ``length`` bytes of ``data`` starting at ``start``.

    Mirrors ``MSG_ReadBitsCompress``: symbols are decoded until the input
    bits are exhausted or ``max_out`` bytes have been produced.
    """
    if _LUT is None:
        _init_lut()
    lut = _LUT
    nbits = _LUT_BITS
    mask = (1 << nbits) - 1
    if length is None:
        length = len(data) - start
    end = start + length
    total_bits = length * 8
    out = bytearray()
    append = out.append
    acc = 0
    have = 0
    used = 0
    pos = start
    while used < total_bits and len(out) < max_out:
        while have < nbits and pos < end:
            acc |= data[pos] << have
            have += 8
            pos += 1
        packed = lut[acc & mask]
        bits = packed & 31
        if used + bits > total_bits:
            # the last code runs past the end of the input: the engine
            # reads zero bits there; such a trailing symbol is padding
            break
        acc >>= bits
        have -= bits
        used += bits
        append(packed >> 5)
    return bytes(out)


def selftest(verbose: bool = False) -> bool:
    """Rebuild the tree from the frequency table and compare with the shipped table."""
    from ._huffman_table import CODES, FINGERPRINT
    built = build_codes()
    ok = built == CODES and fingerprint(built) == FINGERPRINT
    if verbose:
        print(f"huffman: {len(built)} symbols, max code length "
              f"{max(l for _c, l in built.values())} bits, fingerprint {fingerprint(built)[:16]}... "
              f"{'OK' if ok else 'MISMATCH'}")
    return ok


def _write_table(path) -> None:
    codes = build_codes()
    lines = [
        '"""Pre-computed CoD4 Huffman code table - generated by huffman._write_table().',
        "",
        "{symbol: (code, length)}, first bit in bit 0. Do not edit by hand;",
        'regenerate with ``python -m cod4demo.huffman --rebuild``."""',
        "",
        f'FINGERPRINT = "{fingerprint(codes)}"',
        "",
        "CODES = {",
    ]
    for s in range(256):
        c, l = codes[s]
        lines.append(f"    {s}: ({c}, {l}),")
    lines.append("}")
    lines.append("")
    with open(path, "w", encoding="ascii", newline="\n") as fh:
        fh.write("\n".join(lines))


if __name__ == "__main__":
    import sys
    from pathlib import Path
    if "--rebuild" in sys.argv:
        _write_table(Path(__file__).with_name("_huffman_table.py"))
        print("table written")
    else:
        sys.exit(0 if selftest(verbose=True) else 1)
