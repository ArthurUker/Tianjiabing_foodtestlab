"""常驻识别进程：一行一个 JSON 任务，结果写回 stdout。

由 Node 后端按队列串行投递（见 backend/lib/colloidalRecognizer.js）。
import 只做一次；不监听端口、不接触数据库、不读环境中的密钥。
"""
import json
import os
import sys

HOME = os.environ.get('COLLOIDAL_RECOGNIZER_HOME', '/mnt/datadisk0/foodsentinel/recognizer')
sys.path.insert(0, os.path.join(HOME, 'site-packages'))
sys.path.insert(0, os.path.join(HOME, 'core'))

from server_entry import recognize_original  # noqa: E402


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def handle(job):
    if job.get('op') == 'ping':
        emit({'id': job.get('id'), 'pong': True})
        return
    raw = open(job['path'], 'rb').read()
    # debug_id 仅用于本地测试的调试图命名（优先用识别尝试 ID）；未设置 COLLOIDAL_DEBUG_DIR 时不产生文件。
    out = recognize_original(raw, job['projectId'], 'null', job.get('mode') or 'auto',
                             debug_id=job.get('debugId') or job.get('id'))
    emit({'id': job.get('id'), 'result': json.loads(out)})


def main():
    emit({'ready': True})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
        except Exception:
            continue
        try:
            handle(job)
        except Exception as exc:  # 单张失败不拖垮进程
            emit({'id': job.get('id'), 'error': f'{type(exc).__name__}: {exc}'[:300]})


if __name__ == '__main__':
    main()
