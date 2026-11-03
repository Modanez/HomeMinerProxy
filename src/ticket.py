#!/usr/bin/env python3
# Bilhete do dia em PNG (o mesmo do botão 🎟️ do painel), para o bot do Telegram mandar no resumo.
# Lê o /api/mining do painel pela entrada padrão e escreve o PNG na saída padrão (ou em --out arquivo).
# Uso: curl -s localhost:3000/api/mining | python3 ticket.py --lang pt > bilhete.png
# Sai com código 2 quando ainda não há melhor hash de hoje ou hash do último bloco.
import io, json, re, sys
from datetime import datetime

from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 1350
BG, CARD, GOLD, TXT, DIM, OK, WARN = '#0e1117', '#171c26', '#f2a900', '#e6e9ef', '#8a93a6', '#3ecf8e', '#e5534b'
FONT_DIRS = ['/usr/share/fonts/truetype/dejavu/', '/usr/share/fonts/dejavu/', '/usr/share/fonts/TTF/']

STRINGS = {
    'pt': {
        'title': 'BILHETE DE LOTERIA DO BITCOIN', 'best': 'Melhor hash do dia · {}', 'diff': 'dificuldade {}',
        'zeros': '{} zeros na frente', 'block': 'o bloco #{} tinha {} zeros', 'short': 'faltaram {} zeros: {} de vezes mais difícil',
        'won': 'PREMIADO!', 'lost': 'NÃO PREMIADO',
        'foot1': 'Mineração solo em casa: a loteria mais lenta do mundo.', 'foot2': 'Dá para jogar também, é de graça e de código aberto:',
        'months': ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'],
        'date': '{d:02d} de {m} de {y}', 'big': ((1e12, 'trilhões'), (1e9, 'bilhões'), (1e6, 'milhões'), (1e3, 'mil')),
    },
    'en': {
        'title': 'BITCOIN LOTTERY TICKET', 'best': 'Best hash of the day · {}', 'diff': 'difficulty {}',
        'zeros': '{} leading zeros', 'block': 'block #{} had {} zeros', 'short': '{} zeros short: {} times harder',
        'won': 'WINNER!', 'lost': 'NOT A WINNER',
        'foot1': 'Home solo mining: the slowest lottery in the world.', 'foot2': 'You can play too. It is free and open source:',
        'months': ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
        'date': '{m} {d:02d}, {y}', 'big': ((1e12, 'trillion'), (1e9, 'billion'), (1e6, 'million'), (1e3, 'thousand')),
    },
}
REPO = 'github.com/Modanez/HomeMinerProxy'


def font(size, weight='regular'):
    name = {'regular': 'DejaVuSans.ttf', 'bold': 'DejaVuSans-Bold.ttf', 'mono': 'DejaVuSansMono-Bold.ttf'}[weight]
    for d in FONT_DIRS:
        try: return ImageFont.truetype(d + name, size)
        except OSError: pass
    if weight == 'mono':
        return font(size, 'bold')
    try: return ImageFont.load_default(size)
    except TypeError: return ImageFont.load_default()


def fmt(n, digits, lang):
    s = f'{n:,.{digits}f}'
    if digits: s = s.rstrip('0').rstrip('.')
    return s if lang == 'en' else s.replace(',', '#').replace('.', ',').replace('#', '.')


def diff_txt(d, lang):
    return big(d, lang) if d >= 1e3 else fmt(d, 5 if d < 1 else 2, lang)


def big(n, lang):
    for v, w in STRINGS[lang]['big']:
        if n >= v: return fmt(n / v, 1, lang) + ' ' + w
    return fmt(n, 0, lang)


def zeros(h):
    return len(h) - len(h.lstrip('0'))


def render(j, lang='pt'):
    S = STRINGS[lang]
    nb = j.get('nearBlock') or {}
    t, b = nb.get('tip'), nb.get('dayBestHash') or nb.get('bestHash')
    hexre = re.compile(r'^[0-9a-f]{64}$')
    if not t or not b or not hexre.match(str(b.get('hash', ''))) or not hexre.match(str(t.get('hash', ''))):
        return None
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((50, 60, W - 50, H - 60), 36, fill=CARD)
    for cy in (430, 1010):   # recortes do bilhete e linha picotada
        for cx in (50, W - 50): d.ellipse((cx - 34, cy - 34, cx + 34, cy + 34), fill=BG)
        for x in range(100, W - 100, 26): d.line((x, cy, min(x + 14, W - 100), cy), fill=DIM, width=3)

    def text(s, size, y, color, weight='regular'):
        f = font(size, weight)
        w = d.textlength(s, font=f)
        d.text(((W - w) / 2, y), s, font=f, fill=color, anchor='ls')

    at = b.get('at')
    day = datetime.fromtimestamp(at / 1000) if isinstance(at, (int, float)) else datetime.now()
    text(S['title'], 46, 170, GOLD, 'bold')
    text(S['date'].format(d=day.day, m=S['months'][day.month - 1], y=day.year), 36, 235, DIM)
    text(S['best'].format(b.get('worker', '–')), 40, 330, TXT, 'bold')
    text(S['diff'].format(diff_txt(float(b['diff']), lang)), 34, 385, DIM)

    # o hash em duas linhas, zeros em destaque
    h = b['hash']; hz = zeros(h)
    f = font(46, 'mono'); cw = d.textlength('0', font=f); x0 = (W - cw * 32) / 2
    for li in range(2):
        for k, ch in enumerate(h[li * 32:(li + 1) * 32]):
            d.text((x0 + k * cw, 530 + li * 70), ch, font=f, fill=GOLD if li * 32 + k < hz else TXT, anchor='ls')
    zb = zeros(t['hash'])
    text(S['zeros'].format(hz), 40, 700, GOLD, 'bold')
    text(S['block'].format(fmt(t['height'], 0, lang), zb), 34, 755, DIM)
    text(S['short'].format(zb - hz, big(float(t['hashDiff']) / float(b['diff']), lang)), 34, 805, TXT)

    # carimbo, um pouco torto
    won = float(b['diff']) >= float(t.get('target') or float('inf'))
    color = OK if won else WARN
    stamp = Image.new('RGBA', (640, 160), (0, 0, 0, 0))
    sd = ImageDraw.Draw(stamp)
    sd.rounded_rectangle((20, 22, 620, 138), 18, outline=color, width=8)
    sf = font(62, 'bold'); label = S['won'] if won else S['lost']
    sd.text((320, 82), label, font=sf, fill=color, anchor='mm')
    stamp = stamp.rotate(4.6, resample=Image.BICUBIC, expand=True)
    img.paste(stamp, ((W - stamp.width) // 2, 905 - stamp.height // 2), stamp)

    text(S['foot1'], 32, 1090, TXT)
    text(S['foot2'], 30, 1140, DIM)
    text(REPO, 38, 1210, GOLD, 'bold')
    return img


def main():
    args = sys.argv[1:]
    lang = args[args.index('--lang') + 1] if '--lang' in args else 'pt'
    lang = 'pt' if lang.lower().startswith('pt') else 'en'
    j = json.load(open(args[args.index('--json') + 1]) if '--json' in args else sys.stdin)
    img = render(j, lang)
    if img is None:
        sys.exit(2)
    buf = io.BytesIO(); img.save(buf, 'PNG', optimize=True)
    if '--out' in args: open(args[args.index('--out') + 1], 'wb').write(buf.getvalue())
    else: sys.stdout.buffer.write(buf.getvalue())


if __name__ == '__main__':
    main()
