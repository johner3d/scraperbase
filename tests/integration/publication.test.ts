import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

test('publication keeps the old pointer until a candidate validates and publishes',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'scraperbase-publication-'));
  process.env.SCRAPERBASE_DATA_DIR=root;
  const [{openDb},{createPipelineRun},{assembleGeneration,validateGeneration,publishGeneration},{DB_PATH,PUBLISHED_POINTER_PATH}]=await Promise.all([
    import('../../src/core/db/client.ts'),import('../../src/pipeline/store.ts'),import('../../src/pipeline/publication.ts'),import('../../src/core/config/config.ts'),
  ]);
  const db=openDb(DB_PATH);
  try{
    const now='2026-08-30T00:00:00.000Z';
    const set=db.prepare(`INSERT INTO sets(language,source_set_id,name,created_at,updated_at) VALUES('en','base1','Base Set',?,?) RETURNING set_id`).get(now,now) as {set_id:number};
    const card=db.prepare(`INSERT INTO cards(set_id,local_id,name,attributes_json,created_at,updated_at) VALUES(?,'4','Charizard','{}',?,?) RETURNING card_id`).get(set.set_id,now,now) as {card_id:number};
    db.prepare(`INSERT INTO variants(card_id,variant_key,display_label,attributes_json,created_at,updated_at) VALUES(?,'holo|unlimited','Holo','{}',?,?)`).run(card.card_id,now,now);
    const id=createPipelineRun(db,{queries:['charizard psa 10'],marketplaces:['de'],maxItems:10,pageLimit:10,concurrency:1,psaMaxAgeDays:7,salesAuditDays:30,allSales:true});
    await assembleGeneration(db,id);assert.equal(existsSync(PUBLISHED_POINTER_PATH),false);
    const validated=validateGeneration(db,id);assert.equal(existsSync(validated.database),true);assert.equal(existsSync(PUBLISHED_POINTER_PATH),false);
    const published=publishGeneration(db,id);assert.equal(published.generationId,validated.generationId);assert.equal(existsSync(PUBLISHED_POINTER_PATH),true);
    assert.equal(JSON.parse(readFileSync(PUBLISHED_POINTER_PATH,'utf8')).generationId,published.generationId);

    const secondId=createPipelineRun(db,{queries:['pikachu psa 10'],marketplaces:['de'],maxItems:10,pageLimit:10,concurrency:1,psaMaxAgeDays:7,salesAuditDays:30,allSales:true});
    await assembleGeneration(db,secondId);
    validateGeneration(db,secondId);
    const second=publishGeneration(db,secondId);
    assert.notEqual(second.generationId,published.generationId);
    assert.equal(JSON.parse(readFileSync(PUBLISHED_POINTER_PATH,'utf8')).generationId,second.generationId);

    const partialId=createPipelineRun(db,{queries:['mewtwo psa 10'],marketplaces:['de'],maxItems:10,pageLimit:10,concurrency:1,psaMaxAgeDays:7,salesAuditDays:30,allSales:true});
    await assembleGeneration(db,partialId);
    const partialValidated=validateGeneration(db,partialId,{completeness:'partial',incompleteReason:'eBay daily quota reached'});
    assert.equal(partialValidated.completeness,'partial');
    assert.equal(partialValidated.incompleteReason,'eBay daily quota reached');
    const partial=publishGeneration(db,partialId);
    assert.equal(partial.completeness,'partial');
    assert.equal(JSON.parse(readFileSync(PUBLISHED_POINTER_PATH,'utf8')).completeness,'partial');
  }finally{db.close();delete process.env.SCRAPERBASE_DATA_DIR;await rm(root,{recursive:true,force:true});}
});
