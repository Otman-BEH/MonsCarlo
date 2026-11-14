"""Assemble the single-file app: src/ + build/data.json + Astronomy Engine -> index.html (works offline)."""
import json, os, re
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
src = lambda n: open(os.path.join(root, 'src', n), encoding='utf-8').read()
tpl = src('index.tpl.html')
data = json.load(open(os.path.join(root, 'build', 'data.json')))
lib = open(os.path.join(root, 'node_modules', 'astronomy-engine', 'astronomy.browser.min.js'), encoding='utf-8').read()
ver = json.load(open(os.path.join(root, 'node_modules', 'astronomy-engine', 'package.json')))['version']
assert '</script' not in lib
js = '\n'.join(src(n) for n in ('engine.js', 'terrain.js', 'analysis.js', 'globe.js', 'app.js') if os.path.exists(os.path.join(root, 'src', n)))
cdn = re.search(r'<script src="https://cdn\.jsdelivr\.net/npm/astronomy-engine[^"]*"></script>', tpl)
assert cdn, 'astronomy-engine script tag not found in the template'
out = tpl.replace(cdn.group(0), '<script>/* astronomy-engine %s, MIT */\n%s</script>' % (ver, lib))
# plain string replacement (not re.sub) so backslashes in the sources are kept as they are
out = out.replace('/*__CSS__*/', src('style.css')).replace('/*__DATA__*/', json.dumps(data, separators=(',', ':'))).replace('/*__JS__*/', js)
open(os.path.join(root, 'index.html'), 'w', encoding='utf-8').write(out)
print('index.html', len(out) // 1024, 'KB')
