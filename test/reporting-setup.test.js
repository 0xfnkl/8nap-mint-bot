"use strict";
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { HEADERS, ART_HEADERS, grid, planSetup, syncReportingSetup } = require('../reporting-setup');
const A = '0x'+'a'.repeat(40), B = '0x'+'b'.repeat(40);
const NOW = new Date('2026-10-06T23:30:00Z');
const input = v => ({userEnteredValue: typeof v === 'number'?{numberValue:v}:{stringValue:v}});
const list = choices => ({condition:{type:'ONE_OF_LIST',values:choices.map(userEnteredValue=>({userEnteredValue}))},strict:true,showCustomUi:true});
function put(book, sheet, row, col, cell) {
 const s=book.sheets.find(s=>s.properties.title===sheet); const d=s.data[0];
 d.rowData[row-1] ||= {values:[]}; d.rowData[row-1].values[col]=cell;
}
function fixture() {
 const book={sheets:['Project Setup','Artwork Setup','Phase Rules','Project Totals','Mint Adjustments','Wallet Rules'].map((title,sheetId)=>({properties:{title,sheetId,gridProperties:{rowCount:1000,columnCount:24}},data:[{rowData:[]}]}))};
 for(const [sheet,row,headers] of [['Project Setup',9,HEADERS['Project Setup']],['Phase Rules',1,HEADERS['Phase Rules']],['Artwork Setup',9,ART_HEADERS]]) headers.forEach((h,i)=>put(book,sheet,row,i,input(h)));
 for(let r=10;r<=200;r++) {
  put(book,'Project Setup',r,2,{dataValidation:list(['Main','Secondary','Review'])});put(book,'Project Setup',r,3,{dataValidation:list(['Upcoming','Active','Completed','Needs setup'])});
  for(let c=0;c<22;c++) put(book,'Project Totals',r-8,c,{userEnteredValue:{formulaValue:`='Project Setup'!J${r}`}});
 }
 for(let r=10;r<=500;r++) for(const c of [9,10,11,12,13,14,15,16,17,18,19,20,22,23]) put(book,'Artwork Setup',r,c,{userEnteredValue:{formulaValue:c===10?`=IF(OR(J${r}="",B${r}=""),"",J${r}&":"&B${r})`:'=prepared()'},effectiveValue:{stringValue:''}});
 put(book,'Mint Adjustments',3,11,{...input('All projects'),dataValidation:list(['All projects'])});
 for(let r=2;r<=100;r++) put(book,'Wallet Rules',r,3,{dataValidation:list(['All projects'])});
 return book;
}
const project = (overrides={}) => ({address:A,name:'New Collection',artist:'An Artist',standard:'erc721',max:10,editions:[],reporting:{pass:1791331200,allow:1791338400,public:1791352800},projectId:10,slug:'new-collection',hasAuctions:false,...overrides});
const edition = (id=0,max=1) => ({tokenId:String(id),total:0,max,reporting:{name:`Artwork ${id} by Artist ${id}`,pass:1791331200,allow:1791338400,public:1791352800}});
const erc = () => project({name:'Masters',standard:'erc1155',editions:[edition()]});
function existing(book,p,status='Completed') {
 [p.name,'Original Artist','Secondary',status,p.standard==='erc1155'?p.editions.reduce((n,e)=>n+e.max,0):p.max,46000,'','','Manual notes',p.address,p.standard].forEach((v,c)=>put(book,'Project Setup',10,c,input(v)));
}
function recalc(book) {
 const g=grid(book); for(let r=10;r<=500;r++) { const key=g.cell('Artwork Setup',r,9).userEnteredValue?.stringValue,token=g.cell('Artwork Setup',r,1).userEnteredValue?.numberValue;
 if(key && token!=null) g.cell('Artwork Setup',r,10).effectiveValue={stringValue:key+':'+token}; }
}
function apply(book, changes) {
 for(const c of changes) {const before=grid(book).cell(c.sheet,c.row,c.col);put(book,c.sheet,c.row,c.col,{...before,...(c.validationOnly?{}:{userEnteredValue:c.after,effectiveValue:c.after}),...(c.validation?{dataValidation:c.validation}:{})});} recalc(book);
}
function fake(book=fixture()) {
 return {spreadsheetId:'validation',book,writes:0,reads:0,async request(suffix,body){
  if(suffix===':batchUpdate') {this.writes++;
   if(this.failBefore) {this.failBefore=false;throw Error('before write');}
   for(const request of body.requests){
    if(request.addSheet){this.book.sheets.push({properties:request.addSheet.properties,data:[{rowData:[]}]});continue;}
    const u=request.updateCells,s=this.book.sheets.find(s=>s.properties.sheetId===u.start.sheetId),r=u.start.rowIndex+1,c=u.start.columnIndex,v=u.rows[0].values[0];
    const old=grid(this.book).cell(s.properties.title,r,c); put(this.book,s.properties.title,r,c,{...old,...v,...(v.userEnteredValue?{effectiveValue:v.userEnteredValue}:{})});
   }recalc(this.book);if(this.loseResponse){this.loseResponse=false;throw Error('lost response');}return {};
  }
  this.reads++;if(this.onRead)this.onRead(this,suffix);
  return structuredClone(this.book);
 }};
}
function options(t,client,p=project()) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'8nap-setup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 return {client,snapshot:{lastScan:NOW.toISOString(),reportingCatalog:[p]},stateFile:path.join(dir,'state.json'),dryRun:false,now:NOW};
}
test('new project gets Main/Upcoming, phase rules and selector choices; launch promotes only bot-owned status',()=>{
 const book=fixture(),p=project({reporting:{pass:1791417600,allow:0,public:1791439200}});
 const first=planSetup({resource:book,catalog:[p],now:NOW});assert.deepEqual(first.needsReview,[]);
 apply(book,first.changes);const g=grid(book);assert.equal(g.cell('Project Setup',10,2).userEnteredValue.stringValue,'Main');assert.equal(g.cell('Project Setup',10,3).userEnteredValue.stringValue,'Upcoming');
 assert.equal(g.cell('Mint Adjustments',3,11).userEnteredValue.stringValue,'All projects');assert.ok(g.cell('Wallet Rules',100,3).dataValidation.condition.values.some(v=>v.userEnteredValue===p.name));
 const due=planSetup({resource:book,catalog:[p],state:first.next,now:new Date('2026-10-08T23:00Z')});assert.equal(due.changes.filter(c=>c.sheet==='Project Setup').length,1);assert.equal(due.changes.find(c=>c.col===3).after.stringValue,'Active');
 put(book,'Project Setup',10,3,input('Completed'));assert.equal(planSetup({resource:book,catalog:[p],state:first.next,now:new Date('2026-10-08T23:00Z')}).changes.length,0);
});
test('new ERC1155 edition reactivates Completed, updates supply, preserves old metadata and rules',()=>{
 const book=fixture(),p=erc();existing(book,p);const first=planSetup({resource:book,catalog:[p],now:NOW});apply(book,first.changes);
 const oldRules=structuredClone(book.sheets.find(s=>s.properties.title==='Phase Rules').data[0].rowData.slice(0,2));
 p.editions.push(edition(1,3));const next=planSetup({resource:book,catalog:[p],state:first.next,now:NOW});assert.deepEqual(next.needsReview,[]);apply(book,next.changes);
 const g=grid(book);assert.equal(g.cell('Project Setup',10,3).userEnteredValue.stringValue,'Active');assert.equal(g.cell('Project Setup',10,4).userEnteredValue.numberValue,4);assert.equal(g.cell('Project Setup',10,2).userEnteredValue.stringValue,'Secondary');assert.equal(g.cell('Project Setup',10,1).userEnteredValue.stringValue,'Original Artist');assert.equal(g.cell('Project Setup',10,5).userEnteredValue.numberValue,46000);
 assert.equal(g.cell('Artwork Setup',11,9).userEnteredValue.stringValue,A);assert.equal(g.cell('Artwork Setup',11,10).effectiveValue.stringValue,A+':1');assert.deepEqual(book.sheets.find(s=>s.properties.title==='Phase Rules').data[0].rowData.slice(0,2),oldRules);
 assert.equal(planSetup({resource:book,catalog:[p],state:next.next,now:NOW}).changes.length,0);
});
test('manual supply overrides and removed editions fail closed without consuming the baseline',()=>{
 const book=fixture(),p=erc();existing(book,p);const first=planSetup({resource:book,catalog:[p],now:NOW});apply(book,first.changes);put(book,'Project Setup',10,4,input(99));p.editions.push(edition(1));
 const next=planSetup({resource:book,catalog:[p],state:first.next,now:NOW});assert.equal(next.changes.length,0);assert.match(next.needsReview[0],/manual supply preserved/);assert.deepEqual(next.next.observed,first.next.observed);
 p.editions=[edition(2)];assert.match(planSetup({resource:book,catalog:[p],state:first.next,now:NOW}).needsReview[0],/disappeared/);
});
test('new curator editions inherit only a uniform existing special rule',()=>{
 const book=fixture(),p=erc();existing(book,p);[A+':0',p.name,0,'','','','','Curator delivery'].forEach((v,c)=>put(book,'Phase Rules',2,c,input(v)));p.editions.push(edition(1));put(book,'Project Setup',10,4,input(2));
 const plan=planSetup({resource:book,catalog:[p],now:NOW});assert.deepEqual(plan.needsReview,[]);assert.equal(plan.changes.find(c=>c.sheet==='Phase Rules'&&c.col===7).after.stringValue,'Curator delivery');assert.equal(plan.changes.filter(c=>c.sheet==='Phase Rules'&&[3,4,5].includes(c.col)).length,0);
});
test('missing schedules, auction configuration and broken formulas require review without partial project setup',()=>{
 for(const p of [project({reporting:null}),project({hasAuctions:true})]) {const plan=planSetup({resource:fixture(),catalog:[p],now:NOW});assert.equal(plan.changes.length,0);assert.equal(plan.needsReview.length,1);}
 const book=fixture();put(book,'Project Totals',2,8,{});const plan=planSetup({resource:book,catalog:[project()],now:NOW});assert.equal(plan.changes.length,0);assert.match(plan.needsReview[0],/formulas/);
});
test('one atomic batch is idempotent through lost response, and dry runs never write a journal',async t=>{
 const client=fake(),opts=options(t,client);const dry=await syncReportingSetup({...opts,dryRun:true});assert.ok(dry.changes>0);assert.equal(client.writes,0);assert.equal(fs.existsSync(opts.stateFile),false);
 client.loseResponse=true;await assert.rejects(syncReportingSetup(opts),/lost response/);assert.ok(JSON.parse(fs.readFileSync(opts.stateFile)).pending);
 const result=await syncReportingSetup(opts);assert.equal(result.changes,0);assert.equal(client.writes,1);assert.equal(JSON.parse(fs.readFileSync(opts.stateFile)).pending,null);
 const audit=grid(client.book);assert.equal(audit.cell('Setup Log',2,2).userEnteredValue.stringValue,A);assert.equal(audit.cell('Setup Log',3,2).userEnteredValue.stringValue,'project-pickers');
});
test('a rejected write is safely replanned on retry; partial/manual mutation is not retried',async t=>{
 const client=fake(),opts=options(t,client);client.failBefore=true;await assert.rejects(syncReportingSetup(opts),/before write/);await syncReportingSetup(opts);assert.equal(client.writes,2);
 const other=fake(),opts2=options(t,other);other.loseResponse=true;await assert.rejects(syncReportingSetup(opts2),/lost response/);put(other.book,'Project Setup',10,0,input('Manual change'));
 await assert.rejects(syncReportingSetup(opts2),/interrupted write/);assert.equal(other.writes,1);
});
test('stale catalog, workbook mismatch, and changed preparation prevent writes',async t=>{
 const client=fake(),opts=options(t,client);opts.snapshot.lastScan='2026-10-01T00:00:00Z';assert.match((await syncReportingSetup(opts)).needsReview[0],/fresh/);assert.equal(client.writes,0);
 opts.snapshot.lastScan=NOW.toISOString();client.onRead=(c)=>{if(c.reads===6)put(c.book,'Project Totals',2,8,{});};
 await assert.rejects(syncReportingSetup(opts),/formulas or metadata changed/);assert.equal(client.writes,0);
 fs.writeFileSync(opts.stateFile,JSON.stringify({version:1,spreadsheetId:'production'}));await assert.rejects(syncReportingSetup(opts),/another workbook/);
});

test('split reporting projects keep their group and do not recreate the contract as a second project',()=>{
 const book=fixture(),p=erc();existing(book,p);put(book,'Project Setup',10,9,input(A+':0'));p.editions.push(edition(1));
 const plan=planSetup({resource:book,catalog:[p],now:NOW});assert.deepEqual(plan.needsReview,[]);
 assert.equal(plan.changes.find(c=>c.sheet==='Project Setup'&&c.col===9).after.stringValue,A+':1');assert.equal(plan.changes.find(c=>c.sheet==='Project Setup'&&c.col===2).after.stringValue,'Secondary');
 assert.equal(plan.changes.filter(c=>c.sheet==='Project Setup'&&c.col===3).length,1);
});
test('capacity exhaustion stops that collection and preserves prepared formulas',()=>{
 const book=fixture();existing(book,erc());put(book,'Artwork Setup',500,0,input('Other collection'));put(book,'Artwork Setup',500,1,input(0));put(book,'Artwork Setup',500,9,input(B));grid(book).cell('Artwork Setup',500,10).effectiveValue={stringValue:B+':0'};
 const plan=planSetup({resource:book,catalog:[erc()],now:NOW});assert.match(plan.needsReview[0],/500-row/);assert.equal(plan.changes.filter(c=>c.sheet!=='Wallet Rules'&&c.sheet!=='Mint Adjustments').length,0);
});
test('duplicate catalog identities are rejected before any setup',()=>{
 assert.throws(()=>planSetup({resource:fixture(),catalog:[project(),project()]}),/Duplicate/);
});
test('a malformed baseline cannot silently reset edition tracking',()=>{
 assert.throws(()=>planSetup({resource:fixture(),catalog:[erc()],state:{observed:[]}}),/Invalid reporting setup baseline/);
});

test('conflicting optional catalog metadata requests review without consuming its baseline',()=>{
 const book=fixture(),p=erc();existing(book,p);const first=planSetup({resource:book,catalog:[p],now:NOW});apply(book,first.changes);
 p.reportingConflict=true;p.editions.push(edition(1));const result=planSetup({resource:book,catalog:[p],state:first.next,now:NOW});
 assert.equal(result.changes.length,0);assert.match(result.needsReview[0],/metadata conflicts/);assert.deepEqual(result.next.observed,first.next.observed);
});
for(const [name,effectiveValue] of [['blank',{stringValue:''}],['missing',undefined],['errored',{errorValue:{type:'REF',message:'Broken formula'}}],['incorrect',{stringValue:B+':0'}]]) {
 test(`an occupied artwork with a ${name} calculated key cannot be appended again`,async t=>{
  const book=fixture(),p=erc();existing(book,p);const first=planSetup({resource:book,catalog:[p],now:NOW});apply(book,first.changes);
  const key=grid(book).cell('Artwork Setup',10,10);key.effectiveValue=effectiveValue;
  const before=structuredClone(book),client=fake(book),opts=options(t,client,p);
  await assert.rejects(syncReportingSetup(opts),/Artwork Setup row 10.*identity/);
  assert.equal(client.writes,0);assert.equal(fs.existsSync(opts.stateFile),false);assert.deepEqual(book,before);
 });
}
test('an occupied artwork with invalid contract or token cannot be treated as absent',()=>{
 for(const [col,v] of [[9,''],[9,B],[1,''],[1,-1],[1,0.5]]) {
  const book=fixture(),p=erc();existing(book,p);apply(book,planSetup({resource:book,catalog:[p],now:NOW}).changes);
  put(book,'Artwork Setup',10,col,input(v));assert.throws(()=>planSetup({resource:book,catalog:[p],now:NOW}),/identity/);
 }
});
test('an unrecognized prepared artwork-key formula stops a new edition before writing',()=>{
 const book=fixture(),p=erc();put(book,'Artwork Setup',10,10,{userEnteredValue:{formulaValue:'=""'}});
 const plan=planSetup({resource:book,catalog:[p],now:NOW});assert.equal(plan.changes.length,0);assert.match(plan.needsReview[0],/artwork-key formula/);
});
test('reactivation preserves a status formula and the previous edition baseline',()=>{
 const book=fixture(),p=erc();existing(book,p);const first=planSetup({resource:book,catalog:[p],now:NOW});apply(book,first.changes);
 const cell={userEnteredValue:{formulaValue:'="Completed"'},effectiveValue:{stringValue:'Completed'}};put(book,'Project Setup',10,3,cell);p.editions.push(edition(1));
 const result=planSetup({resource:book,catalog:[p],state:first.next,now:NOW});assert.equal(result.changes.length,0);assert.match(result.needsReview[0],/status is formula-owned/);assert.deepEqual(grid(book).cell('Project Setup',10,3),cell);assert.deepEqual(result.next.observed,first.next.observed);
});
test('scheduled launch preserves a manual status formula instead of replacing it with Active',()=>{
 const book=fixture(),p=project({reporting:{pass:1791417600,allow:0,public:1791439200}});const first=planSetup({resource:book,catalog:[p],now:NOW});apply(book,first.changes);
 const cell={userEnteredValue:{formulaValue:'="Upcoming"'},effectiveValue:{stringValue:'Upcoming'}};put(book,'Project Setup',10,3,cell);
 const result=planSetup({resource:book,catalog:[p],state:first.next,now:new Date('2026-10-08T23:00Z')});assert.equal(result.changes.length,0);assert.match(result.needsReview[0],/status is formula-owned/);assert.deepEqual(grid(book).cell('Project Setup',10,3),cell);assert.deepEqual(result.next.upcoming,first.next.upcoming);
});
