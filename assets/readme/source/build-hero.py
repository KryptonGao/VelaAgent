#!/usr/bin/env python3
"""Generate the localized README hero banners (assets/readme/hero.<lang>.svg).

Everything on the right-hand board is a literal Vela identifier (tool names,
file names, agent paths), so only the eyebrow, tagline and three feature chips
change per language. Run from anywhere:

    python3 assets/readme/source/build-hero.py
"""
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent

LANGS = {
    "en": dict(
        lang="en",
        fonts="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif",
        lines=("The desktop AI coding agent", "for your local repositories."),
        chips=("Compact mode", "SubAgents", "Trace view"),
        alt="Vela, the desktop AI coding agent for your local repositories",
    ),
    "zh-CN": dict(
        lang="zh-CN",
        fonts="-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans CJK SC',sans-serif",
        lines=("在本地代码仓库中工作的", "桌面 AI 编程助手"),
        chips=("紧凑模式", "SubAgents", "轨迹界面"),
        alt="Vela，在本地代码仓库中工作的桌面 AI 编程助手",
    ),
    "zh-TW": dict(
        lang="zh-TW",
        fonts="-apple-system,BlinkMacSystemFont,'PingFang TC','Microsoft JhengHei','Noto Sans CJK TC',sans-serif",
        lines=("在本機程式碼儲存庫中運作的", "桌面 AI 程式設計助理"),
        chips=("緊湊模式", "SubAgents", "軌跡介面"),
        alt="Vela，在本機程式碼儲存庫中運作的桌面 AI 程式設計助理",
    ),
    "ja": dict(
        lang="ja",
        fonts="-apple-system,BlinkMacSystemFont,'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic','Meiryo','Noto Sans CJK JP',sans-serif",
        lines=("ローカルのリポジトリで働く", "デスクトップ AI コーディングエージェント"),
        chips=("コンパクトモード", "SubAgents", "トレース表示"),
        alt="Vela、ローカルのリポジトリで働くデスクトップ AI コーディングエージェント",
    ),
    "ko": dict(
        lang="ko",
        fonts="-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic','Noto Sans CJK KR',sans-serif",
        lines=("로컬 저장소에서 일하는", "데스크톱 AI 코딩 에이전트"),
        chips=("간결 모드", "SubAgents", "트레이스 보기"),
        alt="Vela, 로컬 저장소에서 일하는 데스크톱 AI 코딩 에이전트",
    ),
}

MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"
INK, BODY, MUTED = "#12224a", "#2b3a5c", "#6b7a99"
BLUE, SKY, LINE = "#2563eb", "#93c5fd", "#d9e4f7"
GREEN, RED = "#12a36b", "#e0432f"
STAR = "M0,-1 C.1,-.45 .45,-.1 1,0 C.45,.1 .1,.45 0,1 C-.1,.45 -.45,.1 -1,0 C-.45,-.1 -.1,-.45 0,-1Z"


def units(text: str) -> float:
    """Rough rendered width in em: CJK ≈ 1, Latin ≈ 0.56, spaces ≈ 0.3."""
    total = 0.0
    for ch in text:
        if ord(ch) > 0x2E80:
            total += 1.0
        elif ch == " ":
            total += 0.3
        else:
            total += 0.56
    return total


def star(x, y, r, fill=BLUE):
    return f'<path transform="translate({x} {y}) scale({r})" d="{STAR}" fill="{fill}"/>'


def check(x, y, color=GREEN):
    return f'<path d="M{x} {y} l5 5 l10 -11" fill="none" stroke="{color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'


def build(cfg) -> str:
    l1, l2 = cfg["lines"]
    max_w = 548
    size = min(32, max_w / max(units(l1), units(l2)))
    size = round(size, 1)

    chips, x = [], 64
    for text in cfg["chips"]:
        w = round(units(text) * 20 + 36)
        chips.append(
            f'<rect x="{x}" y="356" width="{w}" height="40" rx="20" fill="#ffffff" stroke="{LINE}"/>'
            f'<text x="{x + w / 2}" y="383" text-anchor="middle" font-size="20" font-weight="600" fill="{BODY}">{text}</text>'
        )
        x += w + 12
    assert x - 12 <= 616, f"chips overflow in {cfg['lang']}: {x - 12}"

    nodes = [(0, SKY), (1, BLUE), (2, SKY), (3, BLUE), (4, BLUE), (5, SKY), (6, BLUE), (7, BLUE), (8, SKY), (9, BLUE)]
    tl = []
    for i, color in nodes:
        cx = 676 + i * (432 / 9)
        if i == 6:
            tl.append(f'<circle cx="{cx:.1f}" cy="378" r="11" fill="#ffffff" stroke="{BLUE}" stroke-width="3"/>')
            tl.append(f'<circle cx="{cx:.1f}" cy="378" r="5" fill="{BLUE}"/>')
        else:
            tl.append(f'<circle cx="{cx:.1f}" cy="378" r="6" fill="{color}"/>')

    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="440" viewBox="0 0 1200 440" role="img" aria-labelledby="t d" xml:lang="{cfg["lang"]}" font-family="{cfg["fonts"]}">
  <title id="t">Vela</title>
  <desc id="d">{cfg["alt"]}. The board on the right shows compact tool rows, a SubAgents path tree and a trace timeline.</desc>
  <rect width="1200" height="440" rx="26" fill="#f5f8ff"/>
  <rect x=".5" y=".5" width="1199" height="439" rx="25.5" fill="none" stroke="{LINE}"/>

  <g id="title-block">
    {star(80, 82, 15)}
    <text x="108" y="89" font-family="{MONO}" font-size="20" font-weight="600" letter-spacing="3" fill="{MUTED}">VELAHARNESS</text>
    <text x="60" y="226" font-size="132" font-weight="800" letter-spacing="-4" fill="{INK}">Vela</text>
    <text x="64" y="284" font-size="{size}" font-weight="600" fill="{BODY}">{l1}</text>
    <text x="64" y="{284 + round(size * 1.35)}" font-size="{size}" font-weight="600" fill="{BODY}">{l2}</text>
    {"".join(chips)}
  </g>

  <g id="project-board">
    <rect x="648" y="40" width="488" height="360" rx="20" fill="#ffffff" stroke="{LINE}"/>

    <g font-family="{MONO}" font-size="20" fill="{BODY}">
      <text x="676" y="88"><tspan fill="{BLUE}" font-weight="700">read</tspan>  callback.ts guards.ts <tspan fill="{MUTED}">+1</tspan></text>
      <text x="676" y="126"><tspan fill="{BLUE}" font-weight="700">edit</tspan>  redirect.ts <tspan fill="{GREEN}" font-weight="700">+2</tspan> <tspan fill="{RED}" font-weight="700">−1</tspan></text>
      <text x="676" y="164"><tspan fill="{BLUE}" font-weight="700">bash</tspan>  pnpm test</text>
    </g>
    {check(1086, 154)}
    <path d="M676 192 H1108" stroke="{LINE}"/>

    <g font-family="{MONO}" font-size="20" fill="{BODY}">
      <text x="676" y="228" fill="{MUTED}">spawn_agent ×3</text>
      <path d="M690 244 V326 M690 258 H706 M690 291 H706 M690 326 H706" fill="none" stroke="{SKY}" stroke-width="2" stroke-linecap="round" transform="translate(0 0)"/>
      <text x="716" y="264">/root/routing</text>
      <rect x="708" y="274" width="392" height="34" rx="9" fill="#e8f0ff"/>
      <circle cx="728" cy="291" r="6" fill="{BLUE}"/>
      <text x="744" y="298" font-weight="700" fill="{INK}">/root/auth</text>
      <text x="716" y="332">/root/review</text>
    </g>
    {check(1086, 254)}
    {check(1086, 322)}

    <path d="M676 378 H1108" stroke="{SKY}" stroke-width="2"/>
    {"".join(tl)}
  </g>
</svg>
'''


def main():
    for key, cfg in LANGS.items():
        path = OUT / f"hero.{key}.svg"
        path.write_text(build(cfg), encoding="utf-8")
        print("wrote", path.relative_to(OUT.parent.parent))


if __name__ == "__main__":
    main()
