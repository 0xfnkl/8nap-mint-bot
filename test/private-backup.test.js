"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),zlib=require('node:zlib');
const {SOURCE,captureArchive,decodeArchive,validateSlots,selectedSlots,DriveBackupClient,backupBot}=require('../private-backup');
const {createMintLedger,parseCsv,csvEscape}=require('../mint-ledger');
const {createBotAutonomy}=require('../bot-autonomy');
const {spawnSync}=require('node:child_process');
const now=new Date('2026-10-08T07:45:00.000Z');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'8nap-backup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(path.join(dir,'state/sales'),{recursive:true});
 fs.writeFileSync(path.join(dir,'state/cursor.json'),JSON.stringify({lastProcessedBlock:123,pending:{spreadsheetId:'production'}}));fs.writeFileSync(path.join(dir,'state/sales/cursor.json'),'{}');
 const row={DateUTC:'2026-10-07T23:00:00.000Z',ProjectKey:'0x'+'a'.repeat(40),Collection:'Example',Standard:'erc721',Quantity:'1',MinterWallet:'0x'+'b'.repeat(40),ETHPrice:'0.042',TokenID:'1',Contract:'0x'+'a'.repeat(40),TxHash:'0x'+'c'.repeat(64),BlockNumber:'123',LogIndex:'0'};
 createMintLedger(path.join(dir,'ledger')).append(row,Date.parse(row.DateUTC));return dir;}
const slots=()=>({ownerEmail:'owner@example.com',ownerPermissionId:'owner-permission',botPermissionId:'bot-permission',folderId:'private-folder-123',daily:Array.from({length:7},(_,i)=>'daily-file-'+i),weekly:Array.from({length:4},(_,i)=>'weekly-file-'+i),monthly:Array.from({length:3},(_,i)=>'monthly-file-'+i)});
const credentials={client_email:'bot@example.com',private_key:'synthetic'};
function remote(target,s){return {id:target.id,name:`8nap-bot-${target.slot}.json.gz`,mimeType:'application/gzip',parents:[s.folderId],owners:[{emailAddress:s.ownerEmail}],permissions:[{id:s.ownerPermissionId,type:"user",role:"owner",emailAddress:s.ownerEmail},{id:s.botPermissionId,type:"user",role:"writer",emailAddress:credentials.client_email}],writersCanShare:false,capabilities:{canEdit:true,canShare:false},properties:{backupSource:SOURCE,slot:target.slot}};}

test('captures only restore inputs, preserves pending journals, rejects corrupt content and paths',t=>{
 const dir=fixture(t);fs.writeFileSync(path.join(dir,'.env'),'secret');fs.writeFileSync(path.join(dir,'state/cursor.json.tmp'),'secret');fs.mkdirSync(path.join(dir,'tmp'));fs.writeFileSync(path.join(dir,'tmp/export.csv'),'secret');
 const s=captureArchive(dir,{now,commit:'reviewed'}),m=decodeArchive(s.archive);assert.equal(m.files.length,3);assert.equal(m.commit,'reviewed');assert.equal(JSON.parse(Buffer.from(m.files.find(f=>f.path==='state/cursor.json').data,'base64')).pending.spreadsheetId,'production');
 for(const edit of [m=>m.files[0].path='../.env',m=>m.files.push(m.files[0]),m=>m.files[0].sha256='0'.repeat(64),m=>m.files[0].data='garbage',m=>m.files[0].data+='!!!!',m=>m.files[0].data+='    ',m=>m.files.find(f=>f.path==='state/sales/cursor.json').data='e31=']){const bad=structuredClone(m);edit(bad);assert.throws(()=>decodeArchive(zlib.gzipSync(JSON.stringify(bad))));}
 fs.appendFileSync(path.join(dir,'ledger/mints-2026-10.csv'),'unfinished');assert.throws(()=>captureArchive(dir,{now}),/Mint ledger is invalid/);
});
test('symlinks and oversized source files stop before upload',t=>{
 const dir=fixture(t);fs.symlinkSync(path.join(dir,'state/cursor.json'),path.join(dir,'state/linked.json'));assert.throws(()=>captureArchive(dir,{now}),/non-regular/);
 fs.unlinkSync(path.join(dir,'state/linked.json'));const fd=fs.openSync(path.join(dir,'state/oversized.json'),'w');fs.ftruncateSync(fd,25*1024*1024);fs.closeSync(fd);assert.throws(()=>captureArchive(dir,{now}),/size\/file limit/);
 fs.unlinkSync(path.join(dir,'state/oversized.json'));const csv=fs.openSync(path.join(dir,'ledger/mints-2026-11.csv'),'w');fs.ftruncateSync(csv,25*1024*1024);fs.closeSync(csv);assert.throws(()=>captureArchive(dir,{now}),/size\/file limit/);
});
test('a large valid ledger decodes and restores byte-for-byte within the advertised limits',t=>{
 const dir=fixture(t),ledger=path.join(dir,'ledger/mints-2026-10.csv');
 const [headers,first]=parseCsv(fs.readFileSync(ledger,'utf8'));
 const rows=Array.from({length:20000},(_,i)=>{
  const row=[...first];row[headers.indexOf('TokenID')]=String(i+1);row[headers.indexOf('TxHash')]='0x'+(i+1).toString(16).padStart(64,'0');
  return row.map(csvEscape).join(',');
 });
 const expected=Buffer.from(headers.join(',')+'\n'+rows.join('\n')+'\n');fs.writeFileSync(ledger,expected);assert.ok(expected.length>5000000);
 const snapshot=captureArchive(dir,{now});assert.ok(snapshot.archive.length<8*1024*1024);
 const manifest=decodeArchive(snapshot.archive),saved=manifest.files.find(f=>f.path==='ledger/mints-2026-10.csv');
 assert.deepEqual(Buffer.from(saved.data,'base64'),expected);
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'8nap-restore-large-'));t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 const archive=path.join(parent,'large.json.gz'),restored=path.join(parent,'restored');fs.writeFileSync(archive,snapshot.archive);
 const result=spawnSync(process.execPath,[path.join(__dirname,'../scripts/restore-private-backup.js'),archive,restored],{encoding:'utf8',env:{...process.env,DATA_DIR:dir}});
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).ledgerEvents,20000);
 for(const f of manifest.files)assert.deepEqual(fs.readFileSync(path.join(restored,f.path)),Buffer.from(f.data,'base64'));
});
test('slot rotation retains periods across Vancouver midnight, Monday and year boundaries',()=>{
 const s=validateSlots(slots());const get=iso=>selectedSlots(s,new Date(iso));
 assert.deepEqual(get('2026-10-08T06:59:59Z'),get('2026-10-07T07:00:00Z'));
 assert.notEqual(get('2026-10-08T07:00:00Z')[0].id,get('2026-10-08T06:59:59Z')[0].id);
 assert.notEqual(get('2026-10-12T07:00:00Z')[1].id,get('2026-10-12T06:59:59Z')[1].id);
 assert.notEqual(get('2027-01-01T07:00:00Z')[2].id,get('2027-01-01T06:59:59Z')[2].id);
 const bad=slots();bad.daily[0]=bad.weekly[0];assert.throws(()=>validateSlots(bad),/distinct/);
});
test('sharing or identity changes prevent any upload',async t=>{
 const s=slots(),target=selectedSlots(s,now)[0],snapshot=captureArchive(fixture(t),{now});
 for(const change of [f=>f.permissions.push({id:'anyoneWithLink',type:'anyone',role:'reader'}),f=>f.permissions[1].emailAddress='other@example.com',f=>f.permissions[1].role='reader',f=>f.permissions[1].id='different-bot-id',f=>f.permissions[0].pendingOwner=true,f=>f.writersCanShare=true,f=>f.capabilities.canShare=true,f=>f.name='unrelated.gz',f=>f.parents=['other'],f=>f.owners=[]]){
  const f=remote(target,s);change(f);let writes=0;const client=new DriveBackupClient({credentials,slots:s,getToken:async()=>'secret',fetchImpl:async(_url,o)=>{if(o.method==='PATCH')writes++;return Response.json(_url.includes("/permissions?")?{permissions:f.permissions}:f);}});
  await assert.rejects(client.upload(target,snapshot));assert.equal(writes,0);
 }
});
test('lost upload response is reconciled by stored checksums without another overwrite',async t=>{
 const s=slots(),target=selectedSlots(s,now)[0],snapshot=captureArchive(fixture(t),{now});let f=remote(target,s),writes=0;
 const client=new DriveBackupClient({credentials,slots:s,getToken:async()=>'secret',fetchImpl:async(_url,o)=>{
  assert.equal(o.redirect,'error');if(o.method==='PATCH'){writes++;f={...f,properties:{...f.properties,sha256:snapshot.sha256,capturedAt:snapshot.capturedAt},size:String(snapshot.archive.length),md5Checksum:snapshot.md5};throw new Error('network response lost with sensitive body');}return Response.json(_url.includes("/permissions?")?{permissions:f.permissions}:f);}});
 await assert.rejects(client.upload(target,snapshot),e=>!e.message.includes('sensitive'));
 await client.upload(target,snapshot);assert.equal(writes,1);
});
test('restricted My Drive metadata is accepted only with a complete private ACL',async t=>{
 const s=slots(),target=selectedSlots(s,now)[0],snapshot=captureArchive(fixture(t),{now});
 const f=remote(target,s);delete f.parents;
 Object.assign(f,{md5Checksum:snapshot.md5,properties:{...f.properties,sha256:snapshot.sha256,capturedAt:snapshot.capturedAt}});
 for(const access of [{permissions:f.permissions},{permissions:f.permissions,nextPageToken:'more'},{}]){
  let reads=0,writes=0;
  const client=new DriveBackupClient({credentials,slots:s,getToken:async()=>'secret',fetchImpl:async(url,o)=>{
   if(o.method==='PATCH')writes++;
   if(url.includes('/permissions?')){reads++;return Response.json(access);}
   return Response.json(f);
  }});
  if(access.permissions&&!access.nextPageToken)await client.upload(target,snapshot);
  else await assert.rejects(client.upload(target,snapshot),/sharing changed/);
  assert.equal(reads,1);assert.equal(writes,0);
 }
 const client=new DriveBackupClient({credentials,slots:s,getToken:async()=>'secret',fetchImpl:async(url,o)=>{
  assert.notEqual(o.method,'PATCH');return url.includes('/permissions?')?new Response('{}',{status:403}):Response.json(f);
 }});
 await assert.rejects(client.upload(target,snapshot),/HTTP 403/);
});
test('a corrupt remote write is not acknowledged as a successful backup',async t=>{
 const s=slots(),target=selectedSlots(s,now)[0],snapshot=captureArchive(fixture(t),{now});const f=remote(target,s);
 const client=new DriveBackupClient({credentials,slots:s,getToken:async()=>'secret',fetchImpl:async(url)=>Response.json(url.includes("/permissions?")?{permissions:f.permissions}:f)});
 await assert.rejects(client.upload(target,snapshot),/readback/);
});
test('successful upload sends the exact archive and confirms content plus metadata',async t=>{
 const s=slots(),target=selectedSlots(s,now)[0],snapshot=captureArchive(fixture(t),{now});let f=remote(target,s),writes=0;
 const client=new DriveBackupClient({credentials,slots:s,getToken:async()=>'secret',fetchImpl:async(url,o)=>{
  assert.ok(url.startsWith('https://www.googleapis.com/'));assert.equal(o.headers.Authorization,'Bearer secret');
  if(o.method==='PATCH'){writes++;const start=o.body.indexOf(Buffer.from('Content-Type: application/gzip\r\n\r\n'))+'Content-Type: application/gzip\r\n\r\n'.length;assert.deepEqual(o.body.subarray(start,start+snapshot.archive.length),snapshot.archive);
   f={...f,properties:{...f.properties,sha256:snapshot.sha256,capturedAt:snapshot.capturedAt},size:String(snapshot.archive.length),md5Checksum:snapshot.md5};return Response.json({id:f.id});}
  return Response.json(url.includes("/permissions?")?{permissions:f.permissions}:f);
 }});await client.upload(target,snapshot);assert.equal(writes,1);
});
test('offline restore refuses existing destinations and symlink paths into active data',t=>{
 const dir=fixture(t),snapshot=captureArchive(dir,{now}),archive=path.join(dir,'archive.gz');fs.writeFileSync(archive,snapshot.archive);
 const run=target=>spawnSync(process.execPath,[path.join(__dirname,'../scripts/restore-private-backup.js'),archive,target],{encoding:'utf8',env:{...process.env,DATA_DIR:dir}});
 assert.equal(run(dir).status,1);fs.symlinkSync(dir,path.join(dir,'alias'));assert.equal(run(path.join(dir,'alias/new')).status,1);assert.equal(fs.existsSync(path.join(dir,'new')),false);
});
test('daily capture is identical for all three verified destination copies',async t=>{
 const uploads=[],s=slots();const client={slots:s,async upload(target,snapshot){uploads.push({target,snapshot});}};
 const result=await backupBot({client,dataDir:fixture(t),now});assert.equal(result.verifiedCopies,3);assert.equal(new Set(uploads.map(u=>u.snapshot.sha256)).size,1);assert.equal(new Set(uploads.map(u=>u.target.id)).size,3);
});
test('invalid enabled backup configuration preserves mint and sales monitoring',async t=>{
 const collection={name:'Example',standard:'erc721',contractAddress:'0x'+'a'.repeat(40)},messages=[];
 const a=createBotAutonomy({config:{privateBackup:{enabled:true},sales:{collections:[collection]}},stateDir:path.join(fixture(t),'state'),mintCollections:[collection],env:{},alert:async m=>messages.push(m),log(){}});
 assert.deepEqual(a.mintCollections(),[collection]);assert.deepEqual(a.salesCollections(),[collection]);await a.tick();assert.match(messages[0],/Private backup disabled/);a.stop();
});
