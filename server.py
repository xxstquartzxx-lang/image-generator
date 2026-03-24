"""
server.py – Apparel AI Generator Dev Server
============================================================
Endpoints:
  GET  /api/scenes            → scene/*.txt のファイル名リスト（JSON）
  GET  /api/scene/<name>      → scene/<name>.txt の本文（text）
  POST /api/generate          → Gemini API へ中継して生成画像を返す（JSON）
============================================================
"""
import http.server
import json
import os
import urllib.parse
import urllib.request
import urllib.error
from pathlib import Path

BASE_DIR  = Path(__file__).parent
SCENE_DIR = BASE_DIR / "scene"
PORT      = 3456

# ── .env 読み込み ───────────────────────────────────────────
def load_env(path: Path) -> dict:
    env = {}
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, _, val = line.partition('=')
                env[key.strip()] = val.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return env

ENV = load_env(BASE_DIR / '.env')
GEMINI_API_KEY = ENV.get('GEMINI_API_KEY', '')
GEMINI_MODEL   = ENV.get('GEMINI_MODEL', 'gemini-2.0-flash-exp-image-generation')


# ── Gemini API 呼び出し ─────────────────────────────────────
def call_gemini(image_base64: str, mime_type: str, prompt: str) -> tuple[str, str]:
    """
    Gemini API にプロンプトを送り、生成画像の (base64, mimeType) を返す。

    ◆ 使用モデルについて
      gemini-3.1-flash-image-preview が現在の推奨モデル（画像入出力対応）。
      元画像を inline_data で渡し、テキストで編集指示を与える画像編集モード。
    """
    if not GEMINI_API_KEY or GEMINI_API_KEY == 'your_api_key_here':
        raise ValueError('.env の GEMINI_API_KEY が設定されていません')

    url = (
        f'https://generativelanguage.googleapis.com/v1beta/models/'
        f'{GEMINI_MODEL}:generateContent'
    )

    # Gemini が受け付ける MIME タイプを正規化
    accepted = {'image/jpeg', 'image/png', 'image/gif', 'image/webp'}
    if mime_type not in accepted:
        mime_type = 'image/jpeg'

    # 画像編集モード: inline_data で元画像、text でプロンプトを送信
    payload = {
        'contents': [{
            'parts': [
                {'text': prompt},
                {
                    'inline_data': {
                        'mime_type': mime_type,
                        'data': image_base64,
                    }
                },
            ]
        }],
        'generationConfig': {
            'responseModalities': ['TEXT', 'IMAGE'],
        },
    }

    body = json.dumps(payload).encode('utf-8')
    req  = urllib.request.Request(
        url, data=body,
        headers={
            'Content-Type': 'application/json',
            'x-goog-api-key': GEMINI_API_KEY,
        },
        method='POST',
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode('utf-8', errors='replace')
        print(f'[gemini] HTTP {e.code} error:\n{err_body[:800]}')
        raise RuntimeError(f'Gemini API error {e.code}: {err_body[:200]}') from e

    # レスポンスから画像パーツを抽出
    parts = data.get('candidates', [{}])[0].get('content', {}).get('parts', [])
    for part in parts:
        if 'inlineData' in part:
            return part['inlineData']['data'], part['inlineData'].get('mimeType', 'image/png')

    # 画像パーツがなければ詳細ログ
    snippet = json.dumps(data, ensure_ascii=False)[:800]
    print(f'[gemini] No image in response:\n{snippet}')
    raise RuntimeError('Gemini レスポンスに画像が含まれていません')


# ── HTTP ハンドラ ───────────────────────────────────────────
class AppHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    # ── GET ──
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path   = parsed.path.rstrip('/')

        if path == '/api/scenes':
            self._serve_scenes_list()
        elif path.startswith('/api/scene/'):
            name = urllib.parse.unquote(path[len('/api/scene/'):])
            self._serve_scene_content(name)
        else:
            super().do_GET()

    # ── POST ──
    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path   = parsed.path.rstrip('/')

        if path == '/api/generate':
            self._handle_generate()
        else:
            self.send_response(404)
            self.end_headers()

    # ── /api/generate ──
    def _handle_generate(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)

        try:
            req_data  = json.loads(body.decode('utf-8'))
            img_b64   = req_data['imageBase64']
            mime_type = req_data.get('mimeType', 'image/jpeg')
            prompt    = req_data['prompt']
        except (json.JSONDecodeError, KeyError) as e:
            self._send_error_json(400, f'リクエスト形式が不正です: {e}')
            return

        try:
            result_b64, result_mime = call_gemini(img_b64, mime_type, prompt)
            resp_body = json.dumps({
                'imageBase64': result_b64,
                'mimeType':    result_mime,
            }, ensure_ascii=False).encode('utf-8')
            self._send_json(200, resp_body)
        except Exception as e:
            print(f'[generate] ERROR: {e}')
            self._send_error_json(500, str(e))

    # ── /api/scenes ──
    def _serve_scenes_list(self):
        try:
            SCENE_DIR.mkdir(exist_ok=True)
            names = sorted(f.stem for f in SCENE_DIR.glob('*.txt') if f.is_file())
            self._send_json(200, json.dumps(names, ensure_ascii=False).encode('utf-8'))
        except Exception as e:
            self._send_error_json(500, str(e))

    # ── /api/scene/<name> ──
    def _serve_scene_content(self, name: str):
        safe_name = Path(name).name
        target    = SCENE_DIR / f'{safe_name}.txt'
        if not target.exists():
            self._send_error_json(404, f"Scene '{safe_name}' not found")
            return
        try:
            text = target.read_text(encoding='utf-8-sig')
            body = text.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type',   'text/plain; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self._cors_headers()
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self._send_error_json(500, str(e))

    # ── helpers ──
    def _send_json(self, code: int, body: bytes):
        self.send_response(code)
        self.send_header('Content-Type',   'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, code: int, message: str):
        body = json.dumps({'error': message}, ensure_ascii=False).encode('utf-8')
        self._send_json(code, body)

    def _cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')

    def log_message(self, fmt, *args):
        print(f'[server] {self.address_string()} - {fmt % args}')


# ── 起動 ───────────────────────────────────────────────────
if __name__ == '__main__':
    key_status = '✅ セット済' if (GEMINI_API_KEY and GEMINI_API_KEY != 'your_api_key_here') else '❌ 未設定（.envを確認）'
    print(f'[server] http://localhost:{PORT}')
    print(f'[server] Gemini model : {GEMINI_MODEL}')
    print(f'[server] API key      : {key_status}')
    print(f'[server] Scene dir    : {SCENE_DIR}')
    print(f'[server] Press Ctrl+C to stop\n')
    with http.server.ThreadingHTTPServer(('', PORT), AppHandler) as httpd:
        httpd.serve_forever()
