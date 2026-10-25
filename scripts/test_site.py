import json, os, sys, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
DIST=ROOT/'dist'
SITE=os.environ.get('SITE_ID','tech')
class SiteSmoke(unittest.TestCase):
    def test_only_this_site(self):
        feed=json.loads((DIST/'data/sites'/f'{SITE}.json').read_text(encoding='utf8'))
        self.assertEqual(feed['site']['id'],SITE)
        self.assertEqual(feed['schema'],'static-site-feed/v1')
        self.assertEqual(feed['schema_version'],'1.1.0')
        self.assertGreaterEqual(len(feed['entries']),1)
        for p in feed['entries']:
            self.assertEqual(p['site_id'],SITE)
            self.assertTrue(p['url'].startswith('https://'))
            self.assertIn(f'/{SITE}/#/post/{SITE}/',p['url'])
            self.assertTrue(p['cover']['src'].startswith('data:image/webp;base64,'))
            self.assertTrue((DIST/'data/posts'/SITE/(p['slug']+'.json')).exists())
        self.assertIn('data-mode="site"',(DIST/'index.html').read_text())
        self.assertIn(f'data-site-id="{SITE}"',(DIST/'index.html').read_text())
    def test_preview_export(self):
        from subprocess import run
        run([sys.executable,'scripts/export_preview.py'],cwd=ROOT,check=True,capture_output=True)
        html=(DIST/'preview.html').read_text(encoding='utf8')
        self.assertIn('preview-data',html)
        self.assertIn(f'data-site-id="{SITE}"',html)
if __name__=='__main__':unittest.main()
