import pathlib
src = pathlib.Path('src')
html = (src/'index.template.html').read_text()
html = html.replace('/*__CSS__*/', (src/'style.css').read_text())
html = html.replace('/*__CORE__*/', (src/'core.js').read_text())
html = html.replace('/*__APP__*/', (src/'app.js').read_text())
out = pathlib.Path('.')
(out/'index.html').write_text(html)
print('index.html', len(html.encode()), 'bytes')
