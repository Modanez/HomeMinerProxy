"""Testes do placar do cubo: formatação pt-BR e desenho das telas (precisa do Pillow)."""
import os, sys, time, unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
try:
    import cubo
except ImportError as e:  # sem Pillow
    cubo = None
    MOTIVO = str(e)


@unittest.skipIf(cubo is None, 'Pillow não instalado')
class TestCubo(unittest.TestCase):
    def sample(self):
        now = time.time() * 1000
        return {
            'farm': {'best': 1889.37, 'difficulty': 148.4e12, 'hashrate': 13.1e6, 'workers': [
                {'name': 'macbook', 'state': 'ok', 'hashRate': 9.6e6, 'lastDiff': {'diff': 6.7, 'at': now - 60e3}},
                {'name': 'vovo', 'state': 'quiet', 'hashRate': 3.5e5},
                {'name': 'tablet', 'state': 'stale', 'hashRate': 4.5e6},
                {'name': 'bitaxe', 'state': 'unknown', 'hashRate': 1.2e12},
                {'name': 'velho', 'state': 'stale', 'hashRate': 1, 'inactive': True},
            ]},
            'hall': [{'worker': 'macbook', 'value': 1889.37}],
            'recentRecords': [],
        }

    def test_formatacao(self):
        self.assertEqual(cubo.br(1889.37, 2), '1.889,37')
        self.assertEqual(cubo.diff(0.003214), '0,00321')
        self.assertEqual(cubo.diff(38.76), '38,76')
        self.assertEqual(cubo.hashrate(13.1e6), '13,1 MH/s')
        self.assertEqual(cubo.big(78.5e9), '78,5 bi')

    def test_telas_240x240(self):
        j = self.sample()
        for img in (cubo.draw_board(j), cubo.draw_party({'worker': 'vovo', 'value': 38.76}, j)):
            self.assertEqual(img.size, (240, 240))
            data = cubo.jpeg(img)
            self.assertEqual(data[:2], b'\xff\xd8')
            self.assertLess(len(data), 400 * 1024)

    def test_recorde_novo_so_depois_da_primeira_leitura(self):
        enviados = []
        cubo.upload = lambda data: enviados.append(data)
        j = self.sample()
        j['recentRecords'] = [{'worker': 'macbook', 'value': 1889.37, 't': 1000, 'farm': True}]
        cubo.panel = lambda: j
        st = {}
        cubo.tick(st)                       # 1ª leitura: placar normal, sem festa por recorde antigo
        self.assertNotIn('partyUntil', st)
        j['recentRecords'].append({'worker': 'vovo', 'value': 2500.0, 't': 2000, 'farm': True})
        cubo.tick(st)                       # recorde novo: festa
        self.assertIn('partyUntil', st)
        self.assertEqual(st['recordT'], 2000)
        self.assertEqual(len(enviados), 2)


if __name__ == '__main__':
    unittest.main()
