/* PriceLog: 同名・異方式商品の安全な結合判定。ブラウザと自動テストで共用。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PriceLogMergeCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const nameKey = raw => String(raw || '').normalize('NFKC').replace(/[\u30a1-\u30f6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)).replace(/[\s\u3000]+/g, '').toLowerCase();
  const infoKey = raw => nameKey(raw);
  const unitKey = raw => String(raw || '').normalize('NFKC').trim().toLowerCase();
  const safeNum = value => value === '' || value === null || value === undefined ? '' : (Number.isFinite(Number(value)) ? Number(value) : String(value));
  const amountKey = row => safeNum(row.amount) + '/' + unitKey(row.unit);
  const quantitySame = (a,b) => amountKey(a) === amountKey(b);
  const priceSame = (a,b) => safeNum(a.price) === safeNum(b.price) && (a.priceType==='inc'?'inc':'ex') === (b.priceType==='inc'?'inc':'ex') && safeNum(a.tax) === safeNum(b.tax) && safeNum(a.salePrice) === safeNum(b.salePrice);
  const fullSame = (a,b) => nameKey(a.store)===nameKey(b.store) && infoKey(a.productInfo)===infoKey(b.productInfo) && quantitySame(a,b) && priceSame(a,b);

  function asTypeRow(row, source) {
    const result=copy(row);
    result.amount = safeNum(source.amount) || safeNum(row.amount) || '';
    result.unit = String(source.unit || row.unit || '個').trim();
    result.productInfo = String(row.productInfo || '').trim();
    return result;
  }

  function planMerge(source, target) {
    if (!source || source.kind!=='product' || !target || target.kind!=='type' || nameKey(source.name)!==nameKey(target.name)) throw new Error('結合対象の商品が一致しません。');
    const rows=copy(target.stores || []);
    const conflicts=[]; const duplicates=[]; const distinct=[];
    for (const src of source.stores || []) {
      const row=asTypeRow(src,source);
      const sameStore=rows.filter(t=>nameKey(t.store)===nameKey(row.store));
      const exact=sameStore.find(t=>fullSame(t,row));
      if(exact){duplicates.push({sourceId:src.id,targetId:exact.id});continue;}
      const ambiguous=sameStore.filter(t=>quantitySame(t,row) && (
        infoKey(t.productInfo)===infoKey(row.productInfo) || !infoKey(t.productInfo) || !infoKey(row.productInfo)
      ));
      if(ambiguous.length===1){
        conflicts.push({sourceId:src.id,targetId:ambiguous[0].id,sourceRow:row,targetRow:copy(ambiguous[0])});
      }else{
        // 候補が複数ある場合にも誤統合せず、別行として残す。
        distinct.push({sourceId:src.id,row});
      }
    }
    return {sourceId:source.id,targetId:target.id,sourceSnapshot:JSON.stringify(source),targetSnapshot:JSON.stringify(target),sourceCount:(source.stores||[]).length,targetCount:rows.length,conflicts,duplicates,distinct};
  }

  function executeMerge(source, target, choices={}, makeId, now) {
    if(typeof makeId!=='function') throw new Error('ID生成関数が必要です。');
    const plan=planMerge(source,target);
    const merged=copy(target);
    merged.allowSameStoreVariants=true;
    merged.mergedSourceIds=[...new Set([...(target.mergedSourceIds||[]),...(source.mergedSourceIds||[]),source.id])];
    merged.kind='type';
    merged.labelId = target.labelId || source.labelId || '';
    merged.nameCandidates={...source.nameCandidates,...target.nameCandidates, product:source.nameCandidates?.product||source.name, type:target.nameCandidates?.type||target.name};
    merged.reading=target.reading||source.reading||'';
    merged.updatedAt=now;
    const usedIds=new Set((merged.stores||[]).map(r=>r.id));
    const memoRedirect={};
    const decisions=[];
    const events=[];
    const conflicts=new Map(plan.conflicts.map(x=>[x.sourceId,x]));
    const dupes=new Map(plan.duplicates.map(x=>[x.sourceId,x.targetId]));
    for(const originalRow of source.stores||[]){
      const sourceRow=asTypeRow(originalRow,source);
      if(dupes.has(originalRow.id)){
        memoRedirect[originalRow.id]=dupes.get(originalRow.id);
        decisions.push({sourceId:originalRow.id, action:'duplicate'});
        continue;
      }
      const conflict=conflicts.get(originalRow.id);
      if(conflict){
        const decision=['source','target','keep'].includes(choices[originalRow.id])?choices[originalRow.id]:'keep';
        if(decision!=='keep'){
          const row=merged.stores.find(item=>item.id===conflict.targetId);
          if(row){
            const old=copy(row);
            if(decision==='source'){
              Object.assign(row,sourceRow,{id:old.id,updatedAt:now});
            }
            memoRedirect[originalRow.id]=old.id;
            // 価格データの採用記録。価格変更履歴と区別できるよう action を明記。
            events.push({id:makeId('h'),updatedAt:now,store:row.store||old.store||'',beforePrice:decision==='source'?old.price:sourceRow.price,afterPrice:row.price,mergeAction:decision==='source'?'商品名側を採用':'種類比較側を採用',mergeOrigin:'結合時の選択',productInfo:row.productInfo||sourceRow.productInfo||'',amount:row.amount,unit:row.unit});
            decisions.push({sourceId:originalRow.id,action:decision,targetId:old.id});
            continue;
          }
        }
      }
      const added=sourceRow;
      if(usedIds.has(added.id)) added.id=makeId('s');
      usedIds.add(added.id);
      if(added.id!==originalRow.id) memoRedirect[originalRow.id]=added.id;
      merged.stores.push(added);
      decisions.push({sourceId:originalRow.id,action:conflict?'keep':'distinct',targetId:added.id});
    }
    const hist=[...(target.history||[]).map(h=>({...copy(h),mergeOrigin:h.mergeOrigin||'種類比較'})),...(source.history||[]).map(h=>({...copy(h),mergeOrigin:h.mergeOrigin||'商品名'})),...events];
    const seen=new Set();
    merged.history=hist.filter(item=>{const key=item.id||JSON.stringify([item.updatedAt,item.store,item.beforePrice,item.afterPrice,item.mergeOrigin]); if(seen.has(key))return false;seen.add(key);return true;}).sort((a,b)=>(Date.parse(b.updatedAt||'')||0)-(Date.parse(a.updatedAt||'')||0));
    return {merged,plan,memoRedirect,decisions};
  }
  return {nameKey,fullSame,planMerge,executeMerge,asTypeRow};
});
