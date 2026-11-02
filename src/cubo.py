#!/usr/bin/env python3
# Placar da fazenda no cubo GeekMagic SmallTV (240x240).
# Lê o painel local (/api/mining), desenha uma imagem e manda para o cubo pelo modo "álbum de fotos".
# Uso: python3 cubo.py            (roda em loop; configurável por variáveis de ambiente abaixo)
#      python3 cubo.py --once --out teste.jpg   (só gera a imagem, sem enviar)
import io, json, os, sys, time, uuid, http.client, urllib.request

CUBE_IP = os.environ.get('CUBE_IP', '')                 # IP do cubo na rede de casa (obrigatório para enviar)
PANEL = os.environ.get('PANEL_URL', 'http://127.0.0.1:3000/api/mining')
THEME = os.environ.get('CUBE_THEME', '3')            # 3 = álbum no SmallTV Ultra (4 no Pro)
EVERY_S = int(os.environ.get('CUBE_EVERY_S', '300'))   # atualização normal: a cada 5 min (poupa a flash do cubo)
CHECK_S = 60                                           # recorde novo é checado a cada minuto
PARTY_S = 10 * 60                                      # tela de recorde fica 10 min
NAME = 'fazenda.jpg'
LANG = 'pt' if os.environ.get('LANGUAGE', '').lower().startswith('pt') else 'en'   # pt-BR ou en (padrão)

STRINGS = {
    'pt': {'farm': 'FAZENDA', 'record': 'RECORDE', 'by': 'por ', 'togo': 'faltam {} de vezes',
           'nobody': 'ninguém minerando :(', 'new': 'NOVO RECORDE!', 'now': 'agora',
           'big': ((1e12, 'tri'), (1e9, 'bi'), (1e6, 'mi'), (1e3, 'mil'))},
    'en': {'farm': 'FARM', 'record': 'RECORD', 'by': 'by ', 'togo': '{} times to go',
           'nobody': 'nobody mining :(', 'new': 'NEW RECORD!', 'now': 'now',
           'big': ((1e12, 'T'), (1e9, 'B'), (1e6, 'M'), (1e3, 'k'))},
}
def tx(key): return STRINGS[LANG][key]
STATE = os.path.join(os.environ.get('DATA_DIR') or os.path.dirname(os.path.abspath(__file__)), 'cubo-state.json')

from PIL import Image, ImageDraw, ImageFont

BG, CARD, LINE = (14, 17, 23), (23, 28, 38), (37, 44, 58)
TXT, DIM, GOLD = (230, 233, 239), (138, 147, 166), (242, 169, 0)
OK, WARN = (62, 207, 142), (229, 83, 75)
STATE_COLOR = {'ok': OK, 'quiet': GOLD, 'stale': WARN}

FONT_DIRS = ['/usr/share/fonts/truetype/dejavu/', '/usr/share/fonts/dejavu/', '/usr/share/fonts/TTF/']

def font(size, bold=False):
    name = 'DejaVuSans-Bold.ttf' if bold else 'DejaVuSans.ttf'
    for d in FONT_DIRS:
        try: return ImageFont.truetype(d + name, size)
        except OSError: pass
    try: return ImageFont.load_default(size)
    except TypeError: return ImageFont.load_default()

def width(d, text, f):
    try:
        b = d.textbbox((0, 0), text, font=f); return b[2] - b[0]
    except AttributeError:
        return d.textsize(text, font=f)[0]

def fit(d, text, bold, max_w, start, minimum=10):
    s = start
    while s > minimum and width(d, text, font(s, bold)) > max_w: s -= 1
    return font(s, bold)

# ---------------------------------------------------------------- formatação (pt-BR: 1.889,37 · en: 1,889.37)
def br(n, dec=0):
    s = f'{n:,.{dec}f}'
    return s if LANG == 'en' else s.replace(',', '#').replace('.', ',').replace('#', '.')

def diff(n):
    if n is None: return '–'
    if n < 1: return br(float(f'{n:.3g}'), 6).rstrip('0').rstrip(',.')
    return br(n, 2 if n < 1e4 else 0)

def big(n):
    for v, w in tx('big'):
        if n >= v: return br(n / v, 1) + ' ' + w
    return br(n)

def hashrate(h):
    u = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s']; i = 0
    while h >= 1000 and i < len(u) - 1: h /= 1000; i += 1
    return br(h, 2 if h < 10 else 1 if h < 100 else 0) + ' ' + u[i]

def ago(ms):
    m = (time.time() * 1000 - ms) / 60000
    if m < 1: return tx('now')
    if m < 60: return f'{int(m)} min'
    return br(m / 60, 1) + ' h'

# ---------------------------------------------------------------- desenho
def draw_board(j):
    f = j['farm']
    img = Image.new('RGB', (240, 240), BG); d = ImageDraw.Draw(img)
    d.text((12, 8), tx('farm'), font=font(11, True), fill=DIM)
    hr = hashrate(f.get('hashrate') or 0)
    d.text((228 - width(d, hr, font(11, True)), 8), hr, font=font(11, True), fill=TXT)

    d.text((12, 28), tx('record'), font=font(10), fill=DIM)
    rec = diff(f.get('best') or 0)
    fb = fit(d, rec, True, 216, 40)
    d.text((12, 40), rec, font=fb, fill=GOLD)
    hall = j.get('hall') or []
    holder = hall[0]['worker'] if hall else ''
    D = f.get('difficulty') or 0
    sub = ((tx('by') + holder + ' · ') if holder and holder != '—' else '') + \
          (tx('togo').format(big(D / f['best'])) if f.get('best') else '')
    d.text((12, 88), sub, font=fit(d, sub, False, 216, 12), fill=DIM)
    d.line((12, 109, 228, 109), fill=LINE)

    ws = [w for w in f.get('workers', []) if w.get('state') in ('ok', 'quiet', 'stale') and not w.get('inactive')]
    order = {'ok': 0, 'quiet': 1, 'stale': 2}
    ws.sort(key=lambda w: (order[w['state']], -(w.get('hashRate') or 0)))
    y = 116
    now = time.time() * 1000
    for w in ws[:6]:
        c = STATE_COLOR[w['state']]
        d.ellipse((12, y + 5, 19, y + 12), fill=c)
        d.text((25, y), w['name'][:9], font=font(13, True), fill=TXT if w['state'] == 'ok' else DIM)
        h = hashrate(w.get('hashRate') or 0)
        fh = font(11)
        d.text((158 - width(d, h, fh), y + 2), h, font=fh, fill=DIM)
        ld = w.get('lastDiff')
        if ld and ld.get('diff') is not None:
            t = diff(ld['diff']); fresh = now - ld['at'] < 5 * 60e3
            ft = font(11, fresh)
            d.text((228 - width(d, t, ft), y + 2), t, font=ft, fill=GOLD if fresh else DIM)
        y += 20
    if not ws:
        d.text((12, 130), tx('nobody'), font=font(13), fill=DIM)
    return img

def draw_party(rec, j):
    img = Image.new('RGB', (240, 240), BG); d = ImageDraw.Draw(img)
    for i, x in enumerate(range(0, 240, 16)):                    # "confete" fixo nas bordas
        col = (GOLD, OK, WARN, TXT)[i % 4]
        d.rectangle((x + 3, 6 + (i * 7) % 14, x + 9, 10 + (i * 7) % 14), fill=col)
        d.rectangle((x + 6, 222 - (i * 5) % 14, x + 12, 226 - (i * 5) % 14), fill=col)
    t = tx('new')
    ft = fit(d, t, True, 216, 26)
    d.text(((240 - width(d, t, ft)) / 2, 40), t, font=ft, fill=GOLD)
    v = diff(rec['value'])
    fv = fit(d, v, True, 216, 48)
    d.text(((240 - width(d, v, fv)) / 2, 82), v, font=fv, fill=TXT)
    who = rec['worker']
    fw = fit(d, who, True, 216, 28)
    d.text(((240 - width(d, who, fw)) / 2, 148), who, font=fw, fill=OK)
    D = (j.get('farm') or {}).get('difficulty') or 0
    if D:
        s = tx('togo').format(big(D / rec['value']))
        d.text(((240 - width(d, s, font(12))) / 2, 190), s, font=font(12), fill=DIM)
    return img

def jpeg(img):
    b = io.BytesIO(); img.save(b, 'JPEG', quality=90, optimize=True); return b.getvalue()

# ---------------------------------------------------------------- comunicação com o cubo
def cube(method, path, body=None, headers=None):
    if not CUBE_IP:
        raise RuntimeError('CUBE_IP não definido')
    c = http.client.HTTPConnection(CUBE_IP, 80, timeout=30)
    try:
        c.request(method, path, body=body, headers=headers or {})
        r = c.getresponse(); data = r.read()
        return r.status, data
    except http.client.HTTPException as e:   # o Ultra às vezes manda cabeçalhos duplicados depois de gravar
        return 0, str(e).encode()
    finally:
        c.close()

def upload(data):
    cube('GET', '/delete?file=/image/' + NAME); time.sleep(0.4)
    boundary = uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{NAME}"\r\n'
            f'Content-Type: image/jpeg\r\n\r\n').encode() + data + f'\r\n--{boundary}--\r\n'.encode()
    cube('POST', '/doUpload?dir=/image/', body, {'Content-Type': 'multipart/form-data; boundary=' + boundary,
                                                  'Content-Length': str(len(body))})
    time.sleep(0.5)
    st, listing = cube('GET', '/filelist?dir=/image/')
    if NAME.encode() not in listing:
        raise RuntimeError('o cubo não listou o arquivo depois do upload')
    time.sleep(0.3); cube('GET', '/set?theme=' + THEME)
    time.sleep(0.3); cube('GET', '/set?img=/image/' + NAME)

# ---------------------------------------------------------------- loop
def load_state():
    try: return json.load(open(STATE))
    except Exception: return {}

def save_state(s):
    try: json.dump(s, open(STATE, 'w'))
    except Exception: pass

def panel():
    with urllib.request.urlopen(PANEL, timeout=15) as r:
        return json.load(r)

def newest_farm_record(j):
    farm = [r for r in (j.get('recentRecords') or []) if r.get('farm')]
    return max(farm, key=lambda r: r['t']) if farm else None

def tick(state):
    j = panel()
    now = time.time()
    rec = newest_farm_record(j)
    if rec and state.get('recordT') is None:
        state['recordT'] = rec['t']                        # primeira execução: não comemora recorde antigo
    if rec and rec['t'] > state.get('recordT', 0):
        state['recordT'] = rec['t']; state['partyUntil'] = now + PARTY_S
        upload(jpeg(draw_party(rec, j))); state['lastAt'] = now
        print('recorde no cubo:', rec['worker'], rec['value'], flush=True)
        return
    if now < state.get('partyUntil', 0): return
    if now - state.get('lastAt', 0) >= EVERY_S:
        upload(jpeg(draw_board(j))); state['lastAt'] = now

def wait_panel(timeout_s=120):
    # No boot, o painel pode levar alguns segundos para abrir a porta: espera em vez de registrar falha.
    end = time.time() + timeout_s
    while time.time() < end:
        try:
            panel(); return True
        except Exception:
            time.sleep(3)
    return False

def main():
    if '--once' in sys.argv:
        j = panel() if '--json' not in sys.argv else json.load(open(sys.argv[sys.argv.index('--json') + 1]))
        out = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else None
        img = draw_party(j['hall'][0], j) if '--festa' in sys.argv else draw_board(j)
        if out: open(out, 'wb').write(jpeg(img)); print('imagem salva em', out)
        else: upload(jpeg(img)); print('enviado para', CUBE_IP)
        return
    if not CUBE_IP:
        sys.exit('Defina CUBE_IP com o IP do cubo (ex.: CUBE_IP=192.168.0.50).')
    state = load_state()
    print(f'cubo {CUBE_IP}: placar a cada {EVERY_S}s', flush=True)
    wait_panel()
    while True:
        try:
            tick(state); save_state(state)
        except Exception as e:
            print('falhou:', e, flush=True)
        time.sleep(CHECK_S)

if __name__ == '__main__':
    main()
