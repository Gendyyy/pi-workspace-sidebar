#!/usr/bin/env python3
"""Turn the ANSI frames written by screenshot.mts into PNGs in assets/."""
import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont

ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets")
BG = (31, 36, 48)
SGR = re.compile(r"\x1b\[([0-9;]*)m")
FONT_CANDIDATES = [
    "/System/Library/Fonts/Menlo.ttc",
    "/System/Library/Fonts/SFNSMono.ttf",
    "/System/Library/Fonts/Monaco.ttf",
]
FONT_SIZE = 15
PAD = 18
CHAR_W = 9
LINE_H = 22


def load_font():
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            for index in (0, 1):
                try:
                    return ImageFont.truetype(path, FONT_SIZE, index=index)
                except Exception:
                    continue
    return ImageFont.load_default()


def parse(line):
    """Split one ANSI line into (text, fg, bg, bold) runs."""
    runs = []
    fg = bg = None
    bold = False
    pos = 0
    for match in SGR.finditer(line):
        text = line[pos : match.start()]
        if text:
            runs.append((text, fg, bg, bold))
        pos = match.end()
        params = [p for p in match.group(1).split(";") if p != ""]
        i = 0
        while i < len(params):
            code = params[i]
            if code == "0":
                fg = bg = None
                bold = False
            elif code == "1":
                bold = True
            elif code == "39":
                fg = None
            elif code == "49":
                bg = None
            elif code in ("38", "48") and i + 4 < len(params) and params[i + 1] == "2":
                color = tuple(int(params[i + 2 + k]) for k in range(3))
                if code == "38":
                    fg = color
                else:
                    bg = color
                i += 4
            i += 1
    text = line[pos:]
    if text:
        runs.append((text, fg, bg, bold))
    return runs


def draw_file(name, font):
    src = os.path.join(ASSETS, f"{name}.ansi")
    with open(src, "r", encoding="utf-8") as handle:
        lines = handle.read().split("\n")
    while lines and lines[-1] == "":
        lines.pop()

    width = PAD * 2 + CHAR_W * max(len(SGR.sub("", line)) for line in lines)
    height = PAD * 2 + LINE_H * len(lines)
    image = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(image)

    for row, line in enumerate(lines):
        x = PAD
        y = PAD + row * LINE_H
        for text, fg, bg, _bold in parse(line):
            if bg:
                draw.rectangle([x, y - 2, x + CHAR_W * len(text), y + LINE_H - 4], fill=bg)
            draw.text((x, y), text, font=font, fill=fg or (203, 204, 198))
            x += CHAR_W * len(text)

    out = os.path.join(ASSETS, f"{name}.png")
    image.save(out, "PNG", optimize=True)
    os.remove(src)
    print(f"{out}  {image.size[0]}x{image.size[1]}")


def main():
    names = sys.argv[1:] or ["screenshot"]
    font = load_font()
    for name in names:
        draw_file(name, font)


if __name__ == "__main__":
    main()
