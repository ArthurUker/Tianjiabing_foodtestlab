"""Private local candidate/acceptance capture. Never updates model weights."""
import argparse,hashlib,io,json,os,threading,uuid
from contextlib import ExitStack
from datetime import datetime
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse,parse_qs
import cv2
import numpy as np
from PIL import Image,ImageOps
from candidate_runtime import CandidateReader

HTML='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>检测卡候选模型实测</title>
<style>body{font:16px system-ui;background:#f3f5f8;color:#172637;margin:16px;max-width:1100px}section{background:white;padding:16px;margin:12px 0;border-radius:10px}label{display:block;margin:9px 0}input,select,button{font:inherit;padding:9px;max-width:95%}button{cursor:pointer}canvas{width:100%;max-height:750px;object-fit:contain}pre{white-space:pre-wrap;overflow-wrap:anywhere}.note{color:#6b4e10}table{border-collapse:collapse;width:100%}td,th{padding:8px;border-bottom:1px solid #ddd;text-align:left}</style>
<h1>检测卡候选模型实测</h1><p class="note">研发候选；照片自动定位和读线。人工参考只用于事后对照，不提供给识别模型。本入口不更新权重，不写正式业务合格结论。</p>
<section id="setup"><h2>第一步：为一张实体卡建立采集记录</h2><p>同一实体卡换角度、背景重复拍摄时，继续使用同一记录。换卡才建立新记录。项目以实际所选项目为准。</p>
<label>实体卡编号 <input id="card" placeholder="例如 新卡-001（同一卡保持一致）"></label><label>实际项目 <select id="project"></select></label>
<label>手机/设备标识 <input id="device" placeholder="自动分配，可改名"></label><label>本次采集批次 <input id="batch" placeholder="默认按采集日期，可修改"></label>
<p class="note">这两项会自动带入，只用于整理照片。想沿用以前的设备名称或区分同一天的多批采集时，可以手动修改。</p>
<label><input id="newcard" type="checkbox">确认这是一张未用于旧模型研发的新实体卡</label>
<details><summary>人工参考（可选，直接试拍可跳过）</summary>
<label>场景参考 <select id="scene"><option value="unknown">未知</option><option value="one_complete_card">一张完整检测卡</option><option value="no_card">没有检测卡</option><option value="multiple_cards">两张或更多检测卡</option><option value="truncated_card">卡片被截断</option><option value="unreadable">模糊、遮挡或曝光导致不可读</option></select></label>
<label>参考依据（选填） <input id="truth" placeholder="例如：现场肉眼复核、仪器结果单号"></label>
<p class="note">留空也可拍照保存。没有依据的 C/T 或结果参考只做备注，不计入验收。</p>
<div id="references"></div></details><button id="create">建立记录并开始拍照</button><p id="sessioninfo"></p></section>
<section><h2>第二步：拍照并自动识别</h2><p>卡片外壳边角可以有少量遮挡或出框。请露出所有识别窗和加样口，避免反光、模糊或遮住 C/T 读数区。</p><label>当前背景说明 <input id="background" placeholder="例如 黑桌面、花纹布、手持"></label>
<label>本张照片参考（可选） <select id="region-reference"><option value="unknown">不确定 / 未填写</option><option value="clear">识别窗和加样口清楚，外壳无遮挡</option><option value="shell_only">仅外壳遮挡或出框，识别窗和加样口清楚</option><option value="window_affected">至少一个识别窗受影响</option><option value="well_affected">至少一个加样口受影响</option><option value="both_affected">两类区域均受影响</option></select></label>
<input id="photo" type="file" accept="image/*" capture="environment"><button id="inspect">上传并识别</button><p id="status">请先建立实体卡记录。</p><canvas id="overlay"></canvas><div id="result"></div></section>
<section><h2>已保存的实测记录</h2><button id="refresh">刷新记录</button><div id="records"></div></section>
<script>
let projects=[],session=null,batchDefault='';
const $=id=>document.getElementById(id);function text(id,v){$(id).textContent=v}
const deviceStorageKey='colloidal.capture.device.v1';
function defaultDevice(){
  try{
    const saved=localStorage.getItem(deviceStorageKey);
    if(saved)return saved;
    const suffix=Array.from(crypto.getRandomValues(new Uint8Array(5)),value=>value.toString(16).padStart(2,'0')).join('');
    const id='设备-'+suffix;
    localStorage.setItem(deviceStorageKey,id);
    return id;
  }catch{return ''}
}
function rememberDevice(id){try{if(id!=='device-unidentified')localStorage.setItem(deviceStorageKey,id)}catch{}}
function refs(){let p=projects.find(x=>x.id===$('project').value);$('references').replaceChildren();for(let i=0;i<p.channels.length;i++){let l=document.createElement('label');l.textContent=`通道 ${i+1} ${p.channels[i].name} 的独立参考结果 `;let s=document.createElement('select');s.id='expected'+i;for(let [v,t] of [['unknown','未知'],['negative','阴性'],['positive','阳性'],['invalid','无效']]){let o=document.createElement('option');o.value=v;o.textContent=t;s.append(o)}l.append(s);for(let band of ['c','t']){let span=document.createElement('span');span.textContent=' '+band.toUpperCase()+'线参考 ';let v=document.createElement('select');v.id=band+'visible'+i;for(let [key,name] of [['unknown','未知'],['visible','可见'],['weak','弱可见'],['absent','不可见']]){let o=document.createElement('option');o.value=key;o.textContent=name;v.append(o)}l.append(span,v)}$('references').append(l)}}
async function init(){let d=await(await fetch('/api/projects')).json();projects=d.projects;batchDefault=d.default_batch_id;if(!$('device').value)$('device').value=defaultDevice();if(!$('batch').value)$('batch').value=batchDefault;for(let p of projects){let o=document.createElement('option');o.value=p.id;o.textContent=p.name;$('project').append(o)}refs();$('project').onchange=refs;load()}
$('create').onclick=async()=>{try{let p=projects.find(x=>x.id===$('project').value);let payload={physical_card_id:$('card').value,project_id:p.id,device_id:$('device').value.trim()||defaultDevice(),batch_id:$('batch').value.trim()===batchDefault?'':$('batch').value,new_card_claim:$('newcard').checked,scene_reference:$('scene').value,truth_source:$('truth').value,expected_results:p.channels.map((_,i)=>$('expected'+i).value),line_references:p.channels.map((_,i)=>({c_visible:$('cvisible'+i).value,t_visible:$('tvisible'+i).value}))};let r=await fetch('/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});let d=await r.json();if(!r.ok)throw Error(d.error);session=d.session;rememberDevice(session.device_id);if(session.device_id!=='device-unidentified')$('device').value=session.device_id;if(!payload.batch_id.trim()){$('batch').value=session.batch_id;batchDefault=session.batch_id}text('sessioninfo',`当前实体卡：${session.physical_card_id}；项目：${p.name}；编号：${session.id}`);text('status','可以选择或拍摄照片。每次上传均保留原图。')}catch(e){text('sessioninfo',e.message)}};
function captureHint(s){return ({no_card:'；未定位到检测卡，请靠近拍摄',multiple_cards:'；请只拍一张检测卡',direction_or_structure_unverified:'；未确认识别窗及对应加样口，请露出全部关键区域后重拍',key_regions_unverified:'；关键区域不在画面内，请重拍',partial_measurement:'；部分识别窗未能可靠读线，请检查是否遮挡、反光或模糊'})[s]||''}
$('inspect').onclick=async()=>{if(!session)return text('status','请先建立实体卡记录。');let f=$('photo').files[0];if(!f)return text('status','请先选择照片。');$('inspect').disabled=true;text('status','正在保存原图并自动识别…');try{let q=new URLSearchParams({session:session.id,background:$('background').value,regions:$('region-reference').value});let r=await fetch('/api/inspect?'+q,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:f});let d=await r.json();if(!r.ok)throw Error(d.error);let a=d.prediction;if(!a)throw Error(`原图已保存，识别未完成：${d.error||d.status}`);text('status',`已保存 ${d.id} · ${a.status} · ${a.elapsed_ms} ms${captureHint(a.status)}`);$('result').replaceChildren();let pre=document.createElement('pre');pre.textContent=JSON.stringify({status:a.status,channels:a.channels.map(c=>({通道:c.index,项目:c.name,C:c.measurement?.c,T:c.measurement?.t,C显色:c.measurement?.c_present,T显色:c.t_visible,图像解释:c.image_result,判读状态:c.rule_status})),人工参考:d.reference.expected_results,注意:a.decision_scope},null,2);$('result').append(pre);let im=new Image();im.onload=()=>{let c=$('overlay');c.width=im.width;c.height=im.height;let x=c.getContext('2d');x.drawImage(im,0,0);function poly(p,col){if(!p?.length)return;x.beginPath();x.moveTo(...p[0]);p.slice(1).forEach(q=>x.lineTo(...q));x.closePath();x.strokeStyle=col;x.lineWidth=Math.max(2,im.width/400);x.stroke()}poly(a.geometry.card,'#00b5c8');a.geometry.windows.forEach(p=>poly(p,'#ff8c00'));a.geometry.wells.forEach(p=>poly(p,'#2ca34a'));let g=a.geometry;if(g.direction?.down&&g.card){let p=g.card.reduce((s,q)=>[s[0]+q[0]/4,s[1]+q[1]/4],[0,0]),v=g.direction.down,L=im.height*.08,up=[p[0]-v[0]*L,p[1]-v[1]*L];x.beginPath();x.moveTo(...p);x.lineTo(...up);x.strokeStyle='white';x.stroke();x.beginPath();x.moveTo(...up);x.lineTo(up[0]+v[0]*L*.2+v[1]*L*.12,up[1]+v[1]*L*.2-v[0]*L*.12);x.lineTo(up[0]+v[0]*L*.2-v[1]*L*.12,up[1]+v[1]*L*.2+v[0]*L*.12);x.closePath();x.fillStyle='white';x.fill();x.font=`bold ${Math.max(18,im.width/60)}px sans-serif`;x.fillText('↑ 上',...up)}};im.src='/api/preview?id='+encodeURIComponent(d.id);load()}catch(e){text('status',e.message)}finally{$('inspect').disabled=false}};
async function load(){try{let d=await(await fetch('/api/records')).json();$('records').replaceChildren();for(let r of d.records){let p=document.createElement('p');p.textContent=`${r.created_at} · ${r.physical_card_id} · ${r.status} · ${r.id}`;$('records').append(p)}}catch(e){text('records',e.message)}}$('refresh').onclick=load;init().catch(e=>text('status',e.message));
</script></html>'''


def now():return datetime.now().astimezone().isoformat()
def daily_batch(timestamp):return '采集-'+timestamp[:10].replace('-','')
def load_rows(p):return [json.loads(s) for s in p.read_text().splitlines()] if p.exists() else []


class Store:
    def __init__(self,root,reader):
        self.root=Path(root).resolve();self.reader=reader;self.lock=threading.Lock();self.model_lock=threading.Lock()
        for name in ['objects','results','previews']:(self.root/name).mkdir(parents=True,exist_ok=True)
        self.sessions={r['id']:r for r in load_rows(self.root/'sessions.jsonl')}
        self.records={r['id']:r for r in load_rows(self.root/'records.jsonl')}
    def append(self,name,row):
        with (self.root/name).open('a') as f:f.write(json.dumps(row,ensure_ascii=False,allow_nan=False)+'\n');f.flush();os.fsync(f.fileno())
    def session(self,p):
        fields=['physical_card_id','project_id']
        if any(not isinstance(p.get(k),str) or not p[k].strip() or len(p[k])>120 for k in fields):raise ValueError('请填写实体卡编号并选择项目')
        if any(not isinstance(p.get(k,''),str) or len(p.get(k,''))>120 for k in ('device_id','batch_id')):raise ValueError('设备名称和采集批次最多120个字符')
        if p['project_id'] not in self.reader.projects:raise ValueError('项目不存在')
        expected=p.get('expected_results');count=len(self.reader.projects[p['project_id']]['channels'])
        if not isinstance(expected,list) or len(expected)!=count or any(v not in ['unknown','negative','positive','invalid'] for v in expected):raise ValueError('逐窗参考结果无效')
        line_refs=p.get('line_references',[dict(c_visible='unknown',t_visible='unknown') for _ in range(count)])
        if not isinstance(line_refs,list) or len(line_refs)!=count or any(not isinstance(x,dict) or any(x.get(k) not in ['unknown','visible','weak','absent'] for k in ['c_visible','t_visible']) for x in line_refs):raise ValueError('C/T可见性参考无效')
        source=str(p.get('truth_source') or '').strip()[:500]
        has_reference=any(x!='unknown' for x in expected) or any(x[k]!='unknown' for x in line_refs for k in ['c_visible','t_visible'])
        reference_status='user_reported' if source else 'unsourced' if has_reference else 'unknown'
        scene=p.get('scene_reference','unknown')
        if scene not in ['unknown','one_complete_card','no_card','multiple_cards','truncated_card','unreadable']:raise ValueError('场景参考无效')
        created_at=now()
        row={k:p[k].strip() for k in fields};row.update(id=uuid.uuid4().hex,created_at=created_at,expected_results=expected,
            device_id=p.get('device_id','').strip() or 'device-unidentified',batch_id=p.get('batch_id','').strip() or daily_batch(created_at),
            truth_source=source or None,scene_reference=scene,line_references=line_refs,new_card_claim=p.get('new_card_claim') is True,physical_identity_verified=False,
            role='prospective_acceptance_candidate',reference_status=reference_status)
        with self.lock:self.append('sessions.jsonl',row);self.sessions[row['id']]=row
        return row
    def inspect(self,data,session_id,background,region_reference='unknown'):
        if session_id not in self.sessions:raise ValueError('采集记录不存在，请先建立记录')
        if region_reference not in ('unknown','clear','shell_only','window_affected','well_affected','both_affected'):
            raise ValueError('照片关键区域参考无效')
        session=self.sessions[session_id];sha=hashlib.sha256(data).hexdigest();rid=uuid.uuid4().hex
        path=self.root/'objects'/sha
        with self.lock:
            if not path.exists():
                with path.open('xb') as f:f.write(data);f.flush();os.fsync(f.fileno())
        # References are stored separately and only project identity is passed
        # into inference. Every upload, including invalid files, gets a receipt.
        record=dict(id=rid,created_at=now(),session_id=session_id,physical_card_id=session['physical_card_id'],
            photo_sha256=sha,object=str(path.relative_to(self.root)),background=str(background)[:500],
            reference=dict(expected_results=session['expected_results'],truth_source=session['truth_source'],line_references=session['line_references'],
                           scene_reference=session['scene_reference'],photo_region_reference=region_reference,
                           new_card_claim=session['new_card_claim'],status=session['reference_status']))
        try:
            with Image.open(io.BytesIO(data)) as im:
                if im.width*im.height>30_000_000:raise ValueError('图片超过3000万像素，请使用普通拍照分辨率')
                rgb=np.asarray(ImageOps.exif_transpose(im).convert('RGB'))
            with self.model_lock:prediction=self.reader.inspect(rgb,project_id=session['project_id'])
            small=Image.fromarray(rgb);small.thumbnail((1400,1400));small.save(self.root/'previews'/f'{rid}.jpg',quality=90)
            record['prediction']=prediction;record['status']=prediction['status']
        except Exception as exc:record.update(status='input_or_engine_failed',error=f'{type(exc).__name__}: {exc}',prediction=None)
        result=self.root/'results'/f'{rid}.json';result.write_text(json.dumps(record,ensure_ascii=False,indent=2,allow_nan=False)+'\n')
        with self.lock:self.append('records.jsonl',record);self.records[rid]=record
        return record


def handler(store):
    class Handler(BaseHTTPRequestHandler):
        def reply(self,status,data,kind='application/json; charset=utf-8'):
            body=data if isinstance(data,bytes) else json.dumps(data,ensure_ascii=False,allow_nan=False).encode()
            self.send_response(status);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(body)))
            self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.end_headers();self.wfile.write(body)
        def do_GET(self):
            p=urlparse(self.path)
            if p.path=='/':return self.reply(200,HTML.encode(),'text/html; charset=utf-8')
            if p.path=='/api/readyz':return self.reply(200,dict(ready=True,bundle_id=store.reader.manifest['id'],production_approved=False))
            if p.path=='/api/projects':return self.reply(200,dict(projects=list(store.reader.projects.values()),default_batch_id=daily_batch(now())))
            if p.path=='/api/records':
                with store.lock:records=list(store.records.values())[-100:][::-1]
                return self.reply(200,dict(records=[{k:r.get(k) for k in ['id','created_at','physical_card_id','status']} for r in records]))
            if p.path=='/api/preview':
                rid=parse_qs(p.query).get('id',[''])[0]
                if rid not in store.records:return self.reply(404,dict(error='记录不存在'))
                f=store.root/'previews'/f'{rid}.jpg'
                if f.exists():return self.reply(200,f.read_bytes(),'image/jpeg')
            return self.reply(404,dict(error='not found'))
        def do_POST(self):
            p=urlparse(self.path)
            # Browser CSRF writes from unrelated sites are rejected. Tailnet
            # access control is provided by the existing private network.
            origin=self.headers.get('Origin')
            if origin and urlparse(origin).netloc!=self.headers.get('Host'):return self.reply(403,dict(error='来源不匹配'))
            try:
                n=int(self.headers.get('Content-Length','0'))
                if not 0<n<=25*1024*1024:return self.reply(413,dict(error='文件为空或超过25MB'))
                if p.path=='/api/sessions':return self.reply(201,dict(session=store.session(json.loads(self.rfile.read(n)))))
                if p.path=='/api/inspect':
                    q=parse_qs(p.query);r=store.inspect(self.rfile.read(n),q.get('session',[''])[0],q.get('background',[''])[0],q.get('regions',['unknown'])[0])
                    return self.reply(200,r)
                return self.reply(404,dict(error='not found'))
            except (ValueError,TypeError,json.JSONDecodeError) as exc:return self.reply(400,dict(error=str(exc)))
        def log_message(self,*args):pass
        def log_request(self,code='-',size='-'):
            if self.client_address[0] not in (self.server.server_address[0], '127.0.0.1'):
                print(json.dumps(dict(at=now(), remote_request=True, port=self.server.server_port,
                                      method=self.command, route=urlparse(self.path).path, status=code)),flush=True)
    return Handler


def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--bundle',required=True,type=Path);ap.add_argument('--data',required=True,type=Path)
    ap.add_argument('--host',default='127.0.0.1');ap.add_argument('--port',type=int,default=55617)
    ap.add_argument('--alternate-port',type=int);a=ap.parse_args()
    store=Store(a.data,CandidateReader(a.bundle))
    with ExitStack() as stack:
        server=stack.enter_context(ThreadingHTTPServer((a.host,a.port),handler(store)))
        if a.alternate_port is not None:
            alternate=stack.enter_context(ThreadingHTTPServer((a.host,a.alternate_port),handler(store)))
            threading.Thread(target=alternate.serve_forever,daemon=True).start()
            stack.callback(alternate.shutdown)
        print(json.dumps(dict(ready=True,host=a.host,port=a.port,alternate_port=a.alternate_port,data=str(store.root))),flush=True)
        server.serve_forever()

if __name__=='__main__':main()
