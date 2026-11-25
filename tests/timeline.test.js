import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { createTimelineRouter, validTimelineSession } from '../routes/timeline.js';
import { parseTimelineQuery, timelineDTO, TimelineInputError } from '../timeline.js';

const NOW=Date.parse('2026-11-25T12:00:00Z');
const validSession={createdAt:new Date(NOW-86400000),revokedAt:null};
const admin={disabled:false,roles:['admin']};
const rows=[{key:'trip:one',name:'Private trip',kind:'trip',level:'top',parentKey:null,childKeys:['destination:one'],
  observedFirst:new Date('2026-10-01'),observedLast:new Date('2026-10-14'),firstLocalDate:'2026-10-01',lastLocalDate:'2026-10-14',
  firstPhotoId:'must-not-leak',supportingBatchKeys:['must-not-leak'],_id:'private-db-id',reason:'private evidence',reviewStatus:'draft'}];

async function fixture(t,{session=validSession,account=admin,readError=false}={}) {
  const calls=[];
  const db={collection(name){return{
    async findOne(filter){calls.push({name,filter});if(name==='sessions')return session;if(name==='accounts')return account;
      if(name==='timeline')return{activeGeneration:'generation'};
      return filter.key==='missing'?null:{key:filter.key};},
    find(filter,options){calls.push({name,filter,options});let limit=50;
      return{sort(value){calls.push({sort:value});return this;},limit(value){limit=value;return this;},async toArray(){
        if(readError)throw new Error('secret-PII-must-not-leak');
        return (filter.parentKey ? [{...rows[0],key:'destination:one',parentKey:filter.parentKey,childKeys:[]}] : rows).slice(0,limit);
      }};},
    aggregate(){return{async toArray(){return[{first:new Date('1998-01-01'),last:new Date('2026-11-07')}];}};},
  };}};
  const app=express();let authenticationCalls=0;
  app.use('/timeline',createTimelineRouter({production:()=>true,now:()=>NOW,connect:async()=>db,
    authenticate(req,res,next){authenticationCalls++;if(req.get('X-Test-Auth')!=='yes')return res.status(401).json({error:'unauthorized'});
      req.admin={sessionId:'session',accountId:'account'};next();},
  }));
  const server=createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return{url:`http://127.0.0.1:${server.address().port}`,calls,authCalls:()=>authenticationCalls};
}

test('timeline rejects unauthenticated direct requests before querying any database',async t=>{
  const f=await fixture(t);const res=await fetch(f.url+'/timeline');
  assert.equal(res.status,401);assert.equal(f.calls.length,0);
  assert.match(res.headers.get('cache-control'),/no-store/);assert.match(res.headers.get('vary'),/Cookie/);
});
for(const [label,session,account] of [
  ['old session',{createdAt:new Date(NOW-31*86400000),revokedAt:null},admin],
  ['revoked session',{...validSession,revokedAt:new Date(NOW)},admin],
  ['expired session',{...validSession,expiresAt:new Date(NOW-1)},admin],
  ['missing session',null,admin],['disabled account',validSession,{...admin,disabled:true}],
  ['non-admin account',validSession,{disabled:false,roles:['user']}],
])test(`timeline refuses ${label}`,async t=>{
  const f=await fixture(t,{session,account});const res=await fetch(f.url+'/timeline',{headers:{'X-Test-Auth':'yes'}});
  assert.equal(res.status,401);assert.ok(!f.calls.some(c=>c.name==='spans'||c.name==='timeline'));
});

test('admin role must be an explicit array and malformed session dates fail closed',()=>{
  assert.equal(validTimelineSession(validSession,{disabled:false,roles:'admin'},NOW),false);
  assert.equal(validTimelineSession({createdAt:'not a date'},admin,NOW),false);
});

for(const origin of ['https://evil.example','http://localhost','https://andrewzc.net.evil.example'])test(`production rejects origin ${origin} before auth`,async t=>{
  const f=await fixture(t);const res=await fetch(f.url+'/timeline',{headers:{origin,'X-Test-Auth':'yes'}});
  assert.equal(res.status,403);assert.equal(f.authCalls(),0);assert.equal(f.calls.length,0);
  assert.match(res.headers.get('cache-control'),/no-store/);
});

test('authenticated DTOs omit internal evidence and are never cacheable or conditional 304 responses',async t=>{
  const f=await fixture(t);const res=await fetch(f.url+'/timeline?from=2026-01-01&to=2027-01-01',{headers:{'X-Test-Auth':'yes',Origin:'https://andrewzc.net','If-None-Match':'*'}});
  assert.equal(res.status,200);assert.match(res.headers.get('cache-control'),/private, no-store/);
  assert.equal(res.headers.get('cdn-cache-control'),'no-store');assert.equal(res.headers.get('etag'),null);
  assert.equal(res.headers.get('access-control-allow-origin'),'https://andrewzc.net');
  const data=await res.json();assert.equal(data.spans[0].childCount,1);
  const text=JSON.stringify(data);assert.ok(!text.includes('must-not-leak'));assert.ok(!text.includes('private-db-id'));assert.ok(!text.includes('private evidence'));
  const query=f.calls.find(c=>c.name==='spans'&&c.options);
  assert.equal(query.filter.recordStatus,'active');assert.equal(query.filter.generation,'generation');assert.equal(query.filter.level,'top');
  assert.ok(query.filter.$and[0].observedLast.$gte instanceof Date);
});

test('disclosure children are queried by exact validated parent after authorization',async t=>{
  const f=await fixture(t);const res=await fetch(f.url+'/timeline/spans/trip%3Aone/children',{headers:{'X-Test-Auth':'yes'}});
  assert.equal(res.status,200);assert.equal((await res.json()).spans[0].parentKey,'trip:one');
  assert.equal(f.calls.find(c=>c.name==='spans'&&c.options).filter.parentKey,'trip:one');
});
test('missing child parent returns a non-leaking 404, malformed keys and query objects fail',async t=>{
  const f=await fixture(t);
  for(const path of ['/timeline?from[$ne]=x','/timeline?limit=100000','/timeline?cursor=bad','/timeline?from=2026-02-30','/timeline/spans/%24where/children']){
    const res=await fetch(f.url+path,{headers:{'X-Test-Auth':'yes'}});assert.equal(res.status,400,path);
  }
  const res=await fetch(f.url+'/timeline/spans/missing/children',{headers:{'X-Test-Auth':'yes'}});assert.equal(res.status,404);
});
test('years require authorization and only expose a bounded year list',async t=>{
  const f=await fixture(t);const res=await fetch(f.url+'/timeline/years',{headers:{'X-Test-Auth':'yes'}});
  assert.equal(res.status,200);const data=await res.json();assert.equal(data.years[0],2026);assert.equal(data.years.at(-1),1998);
});
test('private errors do not leak database messages or record contents',async t=>{
  const f=await fixture(t,{readError:true});const res=await fetch(f.url+'/timeline',{headers:{'X-Test-Auth':'yes'}});
  assert.equal(res.status,503);assert.ok(!(await res.text()).includes('secret-PII'));assert.match(res.headers.get('cache-control'),/no-store/);
});
test('cursors are scoped, reject missing keys and preserve page bounds',()=>{
  const good=Buffer.from(JSON.stringify({scope:'top',date:'2026-10-01T00:00:00.000Z',key:'trip:one'})).toString('base64url');
  assert.equal(parseTimelineQuery({cursor:good}).cursor.key,'trip:one');
  assert.throws(()=>parseTimelineQuery({cursor:good},'trip:one'),TimelineInputError);
  const bad=Buffer.from(JSON.stringify({scope:'top',date:'2026-10-01T00:00:00.000Z'})).toString('base64url');
  assert.throws(()=>parseTimelineQuery({cursor:bad}),TimelineInputError);
  assert.equal(timelineDTO(rows[0]).firstPhotoId,undefined);
});
test('default router uses real missing-session protection and fails closed when NODE_ENV is unset',async t=>{
  const previous=process.env.NODE_ENV;delete process.env.NODE_ENV;
  t.after(()=>{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;});
  let reads=0;const app=express();app.use('/timeline',createTimelineRouter({connect:async()=>{reads++;throw new Error('Must not connect');}}));
  const server=createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/timeline`;
  assert.equal((await fetch(url)).status,401);
  assert.equal((await fetch(url,{headers:{Origin:'http://localhost'}})).status,403);
  assert.equal(reads,0);
});
