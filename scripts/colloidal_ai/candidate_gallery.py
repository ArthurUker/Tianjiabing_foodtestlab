"""Read-only view of completed LAN capture receipts and their previews."""

import argparse
from collections import Counter, defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
from urllib.parse import parse_qs, urlparse


PAGE = """<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>检测卡实拍照片与进度</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f1f5f8;color:#16283b;font:16px/1.5 system-ui,sans-serif}
main{max-width:1320px;margin:auto;padding:20px}h1,h2,h3{margin:.35em 0}.sub{color:#4c6278;margin:.5em 0 1em}
.metrics,.photos{display:grid;grid-template-columns:repeat(auto-fit,minmax(194px,1fr));gap:12px}
.metrics div,article,.controls{background:#fff;border:1px solid #d8e2eb;border-radius:12px;padding:12px}
.metrics strong{display:block;font-size:27px}.controls{margin:16px 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
button,select{font:inherit;padding:7px;border:1px solid #91a5b8;border-radius:6px;background:#fff;color:inherit}
a{color:#075b9a}button{cursor:pointer}.photos{grid-template-columns:repeat(auto-fill,minmax(min(100%,265px),1fr))}
article{min-width:0}article img{display:block;width:100%;height:220px;object-fit:contain;background:#eaf0f5;border-radius:8px}
.tag{display:inline-block;margin:4px 6px 2px 0;padding:2px 7px;border-radius:6px;background:#e4eef5}
.warn{background:#fff0ce;color:#673c00}small{color:#4c6278}summary{cursor:pointer}ul{margin:4px 0;padding-inline-start:20px}
dialog{border:none;border-radius:12px;padding:10px;max-width:96vw;max-height:94vh}
dialog::backdrop{background:#152a3bd9}dialog img{display:block;max-width:88vw;max-height:78vh;margin:auto;object-fit:contain}
</style>
<main>
<h1>检测卡实拍照片与进度</h1>
<p class="sub">只读查看，约每 15 秒更新。图像判读供研发对照。<a id="capture" href="/">返回试拍页上传</a></p>
<div class="metrics" id="metrics"></div>
<p id="readiness" aria-live="polite"></p>
<div class="controls">
  <label>卡号 <select id="card"><option value="">全部卡号</option></select></label>
  <label>情况 <select id="filter"><option value="">全部照片</option><option value="review">有通道未确认</option><option value="varies">同卡判读有变化</option><option value="clear">无遮挡</option><option value="shell_only">仅遮外壳</option><option value="window_affected">识别窗受影响</option><option value="well_affected">加样口受影响</option></select></label>
  <button id="refresh">立即刷新</button><small id="updated" aria-live="polite">正在读取…</small>
</div>
<div id="photos" class="photos"></div>
<dialog id="preview"><form method="dialog"><button>关闭大图</button></form><p id="caption"></p><img id="big" alt=""></dialog>
</main>
<script>
const byId=id=>document.getElementById(id);
const tag=(name,content)=>{const el=document.createElement(name);if(content!==undefined)el.textContent=content;return el};
const statuses={measured:'已读线',partial_measurement:'部分通道未确认',direction_or_structure_unverified:'方向或结构未确认',key_regions_unverified:'关键区域未确认',structure_mismatch:'项目与窗数不符',input_or_engine_failed:'识别未完成',no_card:'未找到卡片',multiple_cards:'多个卡片候选'};
const regions={clear:'无遮挡',shell_only:'仅遮外壳',window_affected:'识别窗受影响',well_affected:'加样口受影响',both_affected:'窗和孔均受影响',unknown:'未标记遮挡情况'};
const meanings={positive:'阳性',negative:'阴性',invalid:'无效'};
const reasons={weak_continuous_band:'弱线证据不足',clipped_background:'背景过曝或高光剪切'};
const visible=value=>value===true?'可见':value===false?'不可见':'未知';
let snapshot=null,loading=false,visibleLimit=24;
byId('capture').href=new URL(location.protocol+'//'+location.hostname+':8080/');
function render(){
  const info=snapshot.summary;
  const labels=[['上传记录',info.uploads],['不同原图',info.unique_photos],['登记卡号',info.card_ids],['有通道未确认',info.needs_review],['同卡判读有变化',info.varying_groups],['已标记遮挡对照',info.paired_groups]];
  byId('metrics').replaceChildren(...labels.map(([label,value])=>{const item=tag('div');item.append(tag('strong',value),tag('span',label));return item}));
  byId('readiness').textContent=info.uploads===0?'还没有上传记录。':info.paired_groups>0
    ?'可以开始同卡遮挡对照。对照数按同一卡号、同一项目，且无遮挡与仅遮外壳为两份不同原图计。'
    :'现有照片可以先做逐图复核。要开始遮挡对照，同一卡号、同一项目各拍一张：无遮挡、仅遮外壳，并标记「本张照片参考」。';
  const selected=byId('card').value;
  byId('card').replaceChildren(new Option('全部卡号',''),...info.cards.map(id=>new Option(id,id)));
  byId('card').value=info.cards.includes(selected)?selected:'';
  const filter=byId('filter').value;
  const records=snapshot.records.filter(r=>(!byId('card').value||r.card===byId('card').value)&&
    (!filter||(filter==='review'?r.status!=='measured':filter==='varies'?r.varies:r.region===filter)));
  const nodes=records.slice(0,visibleLimit).map(r=>{
    const item=tag('article'), title=tag('h3',r.card+' · '+r.project), status=tag('span',statuses[r.status]||r.status), region=tag('span',regions[r.region]||regions.unknown);
    status.className=r.status==='measured'?'tag':'tag warn';region.className='tag';
    item.append(title,tag('small',r.created_at.slice(0,19).replace('T',' ')+' · '+r.id.slice(0,8)),tag('br'),status,region);
    if(r.varies){const badge=tag('span','同卡重复判读有变化');badge.className='tag warn';item.append(badge)}
    if(r.preview){
      const link=tag('a'), src='/api/preview?id='+encodeURIComponent(r.id), image=tag('img');
      image.src=src;image.loading='lazy';image.alt=r.card+'实拍照片，点开大图';link.href=src;link.append(image);
      link.onclick=e=>{if(!byId('preview').showModal)return;e.preventDefault();byId('caption').textContent=title.textContent;byId('big').src=src;byId('big').alt=image.alt;byId('preview').showModal()};
      item.append(link);
    }else item.append(tag('p','此记录没有可用预览'));
    if(r.channels.length){
      const details=tag('details'), lines=tag('ul');details.append(tag('summary','查看 C/T 与图像判读'));
      for(const channel of r.channels){
        const detail=(channel.name?'｜'+channel.name:'')+'：C '+visible(channel.c)+'，T '+visible(channel.t)
          +'；'+(meanings[channel.result]||'未判读')+(channel.reason?'（'+(reasons[channel.reason]||'图像质量不足')+'）':'');
        lines.append(tag('li','通道 '+channel.index+detail));
      }
      details.append(lines);item.append(details);
    }
    return item;
  });
  if(!nodes.length)nodes.push(tag('p','没有符合当前筛选的照片。'));
  if(records.length>visibleLimit){
    const more=tag('button','再看 24 张 · 共 '+records.length+' 张');more.onclick=()=>{visibleLimit+=24;render()};nodes.push(more);
  }
  byId('photos').replaceChildren(...nodes);
}
async function refresh(){
  if(loading)return;
  loading=true;
  try{
    const response=await fetch('/api/gallery',{cache:'no-store'});
    if(!response.ok)throw Error('暂时无法读取记录');
    const next=await response.json();
    if(snapshot?.revision!==next.revision){snapshot=next;render()}
    byId('updated').textContent='已更新 '+new Date().toLocaleTimeString();
  }catch(e){byId('updated').textContent=e.message}finally{loading=false}
}
for(const id of ['card','filter'])byId(id).onchange=()=>{visibleLimit=24;if(snapshot)render()};
byId('refresh').onclick=refresh;
refresh();setInterval(()=>{if(!document.hidden)refresh()},15000);
</script></html>"""


def read_rows(path):
    if not path.is_file():
        return []
    content = path.read_bytes()
    return [json.loads(line) for line in content.split(b'\n')[:-1] if line]


def gallery(data, projects):
    uploads = read_rows(data / 'records.jsonl')
    sessions = {row['id']: row for row in read_rows(data / 'sessions.jsonl')}
    groups = defaultdict(lambda: defaultdict(set))
    outputs = defaultdict(lambda: defaultdict(set))
    records = []
    for record in reversed(uploads):
        session = sessions.get(record['session_id'], {})
        project = session.get('project_id', '')
        card_project = (record['physical_card_id'], project)
        reference = record.get('reference') or {}
        region = reference.get('photo_region_reference') or 'unknown'
        photo_sha = record.get('photo_sha256')
        if project and photo_sha and region in ('clear', 'shell_only'):
            groups[card_project][region].add(photo_sha)
        prediction = record.get('prediction') or {}
        channels = []
        for channel in prediction.get('channels', []):
            measurement = channel.get('measurement') or {}
            result = channel.get('image_result')
            if project and photo_sha and result in ('positive', 'negative', 'invalid'):
                version = prediction.get('bundle_id')
                outputs[card_project + (version, channel.get('index'))][result].add(photo_sha)
            channels.append(dict(name=channel.get('name'), index=channel.get('index'), c=measurement.get('c_present'),
                                 t=channel.get('t_visible'), result=result,
                                 reason=measurement.get('decision_reason')))
        rid = record['id']
        records.append(dict(id=rid, card=record['physical_card_id'], project=projects.get(project, project or '未记录项目'),
                            created_at=record['created_at'], status=record['status'], region=region,
                            preview=(data / 'previews' / f'{rid}.jpg').is_file(), channels=channels, card_project=card_project))
    statuses = Counter(row['status'] for row in uploads)
    pairs = sum(bool(group['clear'] and group['shell_only'] and len(group['clear'] | group['shell_only']) > 1)
                for group in groups.values())
    varying = {key[:2] for key, outcomes in outputs.items()
               if len(outcomes) > 1 and len(set.union(*outcomes.values())) > 1}
    for row in records:
        row['varies'] = row.pop('card_project') in varying
    card_ids = sorted({row['physical_card_id'] for row in uploads})
    summary = dict(uploads=len(uploads), unique_photos=len({row['photo_sha256'] for row in uploads if row.get('photo_sha256')}),
                   card_ids=len(card_ids), cards=card_ids, needs_review=len(uploads) - statuses['measured'],
                   paired_groups=pairs, varying_groups=len(varying), statuses=dict(statuses))
    return dict(revision=f"{len(uploads)}:{records[0]['id'] if records else ''}", summary=summary, records=records)


def serve(data, projects, host, port):
    class Handler(BaseHTTPRequestHandler):
        def reply(self, status, body, content_type):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            target = urlparse(self.path)
            if target.path == '/':
                return self.reply(200, PAGE.encode(), 'text/html; charset=utf-8')
            if target.path == '/api/gallery':
                body = json.dumps(gallery(data, projects), ensure_ascii=False, allow_nan=False).encode()
                return self.reply(200, body, 'application/json; charset=utf-8')
            if target.path == '/api/preview':
                preview_id = parse_qs(target.query).get('id', [''])[0]
                if re.fullmatch(r'[0-9a-f]{32}', preview_id):
                    photo = data / 'previews' / f'{preview_id}.jpg'
                    if photo.is_file():
                        return self.reply(200, photo.read_bytes(), 'image/jpeg')
            return self.reply(404, b'Not found', 'text/plain; charset=utf-8')

        def log_message(self, *args):
            pass

    return ThreadingHTTPServer((host, port), Handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', type=Path, required=True)
    parser.add_argument('--projects', type=Path, required=True)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8081)
    args = parser.parse_args()
    data = args.data.resolve()
    projects = {row['id']: row['name'] for row in json.loads(args.projects.read_text())['projects']}
    with serve(data, projects, args.host, args.port) as server:
        print(f'Capture gallery: http://{args.host}:{args.port}/', flush=True)
        server.serve_forever()


if __name__ == '__main__':
    main()
