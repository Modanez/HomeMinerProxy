# Bilhete do dia em PNG (ticket.py): tamanho, idiomas e saída sem dados.
import io, json, os, subprocess, sys, unittest

SRC = os.path.join(os.path.dirname(__file__), '..', 'src')
sys.path.insert(0, SRC)
import ticket  # noqa: E402

SNAP = {'nearBlock': {
    'tip': {'height': 974200, 'hash': '0' * 20 + 'ab' * 22, 'hashDiff': 6.08e14, 'target': 1.484e14},
    'dayBestHash': {'worker': 'vovo', 'diff': 38.76, 'hash': '0' * 10 + 'cd' * 27, 'at': 1793743993960, 'date': '2026-11-03'},
}}


class TicketTest(unittest.TestCase):
    def test_render_both_languages(self):
        for lang in ('pt', 'en'):
            img = ticket.render(SNAP, lang)
            self.assertEqual(img.size, (1080, 1350))

    def test_numbers(self):
        self.assertEqual(ticket.big(1.166e14, 'pt'), '116,6 trilhões')
        self.assertEqual(ticket.big(1.166e14, 'en'), '116.6 trillion')
        self.assertEqual(ticket.diff_txt(0.00149, 'pt'), '0,00149')
        self.assertEqual(ticket.diff_txt(1889.37, 'pt'), '1,9 mil')
        self.assertEqual(ticket.zeros('000abc'), 3)

    def test_cli(self):
        r = subprocess.run([sys.executable, os.path.join(SRC, 'ticket.py'), '--lang', 'en'], input=json.dumps(SNAP).encode(), capture_output=True)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout[:4], b'\x89PNG')
        r = subprocess.run([sys.executable, os.path.join(SRC, 'ticket.py')], input=b'{"nearBlock": {}}', capture_output=True)
        self.assertEqual(r.returncode, 2)
        bad = json.loads(json.dumps(SNAP)); bad['nearBlock']['dayBestHash']['hash'] = '<script>'
        self.assertIsNone(ticket.render(bad, 'pt'))


if __name__ == '__main__':
    unittest.main()
