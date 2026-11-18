"""Audit prospective captures; empty/unknown/repeated-photo evidence cannot pass."""
import argparse,json
from pathlib import Path
from collections import Counter,defaultdict

def load_rows(p):return [json.loads(s) for s in p.read_text().splitlines()] if p.exists() else []


def audit(data):
    sessions={r['id']:r for r in load_rows(Path(data)/'sessions.jsonl')};records=load_rows(Path(data)/'records.jsonl')
    cards=defaultdict(list);counts=Counter();line=Counter();scenes=Counter();results=Counter();conflicts=[];devices=set();batches=set()
    for r in records:
        s=sessions.get(r['session_id'])
        if not s:conflicts.append(dict(id=r['id'],reason='missing_session'));continue
        if not s['new_card_claim']:counts['not_claimed_new_card']+=1;continue
        cards[s['physical_card_id']].append((s,r));batches.add(s['batch_id'])
        if s['device_id']!='device-unidentified':devices.add(s['device_id'])
        p=r.get('prediction');counts['photos']+=1
        if not p:counts['input_or_engine_failed']+=1;continue
        sc=s.get('scene_reference','unknown');scenes[sc]+=1
        predscene=p.get('geometry',{}).get('status','unverified')
        if sc in ['no_card','multiple_cards','truncated_card','unreadable']:
            counts['abnormal_photos']+=1
            counts['abnormal_rejected']+=int(predscene!='geometry_ready' or p['status']!='measured')
        if sc=='one_complete_card':
            counts['complete_card_photos']+=1;counts['complete_card_processed']+=int(p['status']=='measured')
        for j,ref in enumerate(s['expected_results']):
            ch=p['channels'][j] if j<len(p['channels']) else {}
            if ref!='unknown' and s['truth_source']:
                counts['known_assay_channels']+=1;results[ref]+=1
                observed=ch.get('image_result')
                counts['assay_channels_with_output']+=int(observed is not None)
                counts['assay_reference_agreement']+=int(observed==ref)
            for band in ['c','t']:
                visible=s.get('line_references',[{}]*len(s['expected_results']))[j].get(band+'_visible','unknown')
                if visible=='unknown' or not s['truth_source']:continue
                line[band+'_known']+=1
                value=ch.get('measurement',{}).get('c_present') if band=='c' else ch.get('t_visible')
                line[band+'_agreement']+=int(value is not None and value==(visible in ['visible','weak']))
                if band=='c' and visible=='absent':line['c_absent_examples']+=1
    for card,items in cards.items():
        keys={(s['project_id'],tuple(s['expected_results'])) for s,r in items}
        if len(keys)>1:conflicts.append(dict(physical_card_id=card,reason='project_or_reference_conflict'))
    # These are preconditions for an initial supervised pilot, not a statistical
    # claim that 30 repeated cards establish 99% field robustness.
    gates=dict(new_card_claims_at_least30=len(cards)>=30,devices_at_least2=len(devices)>=2,
        capture_batches_at_least2=len(batches)>=2,positive_channels_at_least5=results['positive']>=5,
        negative_channels_at_least5=results['negative']>=5,c_absent_examples_at_least5=line['c_absent_examples']>=5,
        no_card_examples_at_least5=scenes['no_card']>=5,multiple_card_examples_at_least5=scenes['multiple_cards']>=5,
        no_identity_conflicts=not conflicts,identity_source_independently_verified=False,
        valid_time_and_intensity_calibration_verified=False)
    return dict(schema_version=1,uploaded_records=len(records),unique_photo_bytes=len({r['photo_sha256'] for r in records}),
        new_physical_card_claims=len(cards),independently_verified_card_count=0,devices=len(devices),capture_batches=len(batches),
        counts=dict(counts),line_references=dict(line),result_classes=dict(results),scene_references=dict(scenes),
        conflicts=conflicts,preconditions=gates,independent_acceptance_passed=False,
        note='No automatic pass: card identity, valid read time and numerical C/T calibration require separate evidence; image_result is not final_result.')


def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--data',required=True,type=Path);ap.add_argument('--output',required=True,type=Path);a=ap.parse_args()
    result=audit(a.data);a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__':main()
