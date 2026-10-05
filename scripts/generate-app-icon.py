#!/usr/bin/env python3
"""把 assets/icon/VelaHarnessIcon.png 加工成 macOS 应用图标,输出到 apps/desktop/resources/icon.png。

macOS 不会自动给 Dock 图标加圆角:圆角形状、四周留白和透明的四角都要画进 PNG。
按 Apple 图标网格(1024 画布、圆角方块 824×824、圆角半径 185.4)把原图铺进圆角形状内,
超采样后缩到 1024,保证边缘平滑。原图保持不动,改了原图后重跑本脚本即可。

依赖:Pillow(python3 -m pip install --user pillow)
"""
from pathlib import Path

from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "assets" / "icon" / "VelaHarnessIcon.png"
DST = REPO / "apps" / "desktop" / "resources" / "icon.png"

CANVAS = 1024
SHAPE = 824  # 圆角方块边长,占画布 80%,与系统图标对齐
RADIUS = 185.4
SS = 4  # 超采样倍数,抗锯齿


def main() -> None:
    artwork = Image.open(SRC).convert("RGBA")
    size = SHAPE * SS
    canvas_px = CANVAS * SS

    art = artwork.resize((size, size), Image.LANCZOS)

    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=RADIUS * SS, fill=255
    )
    rounded = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    rounded.paste(art, (0, 0), mask)

    canvas = Image.new("RGBA", (canvas_px, canvas_px), (0, 0, 0, 0))
    offset = (CANVAS - SHAPE) // 2 * SS
    canvas.paste(rounded, (offset, offset), rounded)

    canvas = canvas.resize((CANVAS, CANVAS), Image.LANCZOS)
    DST.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(DST)
    print(f"已生成 {DST}")


if __name__ == "__main__":
    main()
