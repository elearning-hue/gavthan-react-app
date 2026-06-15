// ============================================================================
// app.js — Gavthan billing app (converted from monolithic index.html)
//
// This file preserves the original, battle-tested runtime logic verbatim. The
// only changes from the monolith are:
//   * ES module imports replace CDN <script> globals
//   * Globals the original code expects (React, ReactDOM, supabase, Sortable,
//     html2canvas, XLSX, ESCPOS, ThermalPrinter) are bound below so the body
//     needs no edits
//   * The ReactDOM.render(...) call moved to main.js; Root is exported instead
//   * Config still reads window.GH_CONFIG / window.GH_ADMINS, which main.js
//     populates from Vite env vars (see .env / .env.example)
//
// google.accounts (Google Identity Services) remains a runtime global, loaded
// via the GIS <script> tag in index.html — it has no clean npm equivalent.
// ============================================================================
import './config-init.js'; // MUST be first: populates window.GH_CONFIG before app code reads it
import React from 'react';
import { createClient } from '@supabase/supabase-js';
import Sortable from 'sortablejs';
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import * as XLSX from 'xlsx';
import { ESCPOS, ThermalPrinter } from './thermal-print.js';

// ── Bind the names the original code references as globals ──
// The monolith called window.supabase.createClient(...); expose the same shape.
if (typeof window !== 'undefined') {
  window.supabase = window.supabase || { createClient };
}
// These are referenced bare (e.g. `Sortable.create`, `XLSX.utils`, `typeof html2canvas`).
/* eslint-disable no-unused-vars */


'use strict';

// ── CONFIG ─────────────────────────────────────────
var SUPABASE_URL    = (window.GH_CONFIG||{}).supabaseUrl  || '';
var SUPABASE_KEY    = (window.GH_CONFIG||{}).supabaseKey  || '';
var UPI_ID          = (window.GH_CONFIG||{}).upiId        || '';
var HOTEL_NAME      = (window.GH_CONFIG||{}).hotelName    || 'Gavthan';
var PARTNER_DISCOUNT= Number((window.GH_CONFIG||{}).partnerDiscount)||0;
var GOOGLE_CLIENT_ID= (window.GH_CONFIG||{}).googleClientId  || '';
var ADMIN_EMAILS    = ((window.GH_ADMINS)||[]).map(function(e){return e.toLowerCase();});

// ── Google Drive backup helper (server-side refresh token) ────────────
// OAuth code flow with PKCE → Edge Function exchanges code for refresh+access tokens
// → refresh token stored encrypted server-side → all devices share one Drive connection.
var Drive=(function(){
  var ACCESS_KEY='gh_drive_access';
  var FOLDER_NAME='Gavthan Backups';
  function getAccess(){
    try{var s=sessionStorage.getItem(ACCESS_KEY);if(!s)return null;var o=JSON.parse(s);
      if(o.exp&&Date.now()>o.exp-30000)return null;return o.token;}catch(e){return null;}
  }
  function setAccess(t,expSec){
    sessionStorage.setItem(ACCESS_KEY,JSON.stringify({token:t,exp:Date.now()+(expSec||3500)*1000}));
  }
  function clearAccess(){sessionStorage.removeItem(ACCESS_KEY);}
  function configured(){return !!GOOGLE_CLIENT_ID;}
  function edgeUrl(){
    var url=(window.GH_CONFIG||{}).supabaseUrl||'';
    url=url.replace(/\/rest\/v1\/?$/,'').replace(/\/$/,'');
    return url+'/functions/v1/drive-token';
  }
  function callEdge(action,body){
    // Supabase session JWT is required so the function can verify the caller
    return supa.auth.getSession().then(function(r){
      var jwt=r&&r.data&&r.data.session&&r.data.session.access_token;
      if(!jwt) throw new Error('Sign in first.');
      var payload=Object.assign({action:action},body||{});
      return fetch(edgeUrl(),{
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+jwt,'apikey':SUPABASE_KEY},
        body:JSON.stringify(payload)
      }).then(function(rs){return rs.json().then(function(j){if(!rs.ok)throw new Error(j.error||('HTTP '+rs.status));return j;});});
    });
  }
  // PKCE helpers
  function b64url(buf){return btoa(String.fromCharCode.apply(null,new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
  function genVerifier(){var a=new Uint8Array(48);crypto.getRandomValues(a);return b64url(a.buffer);}
  function challenge(v){return crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)).then(b64url);}
  function authorize(){
    return new Promise(function(resolve,reject){
      if(!configured()){reject(new Error('Google Client ID not configured.'));return;}
      if(typeof google==='undefined'||!google.accounts){reject(new Error('Google Identity Services not loaded.'));return;}
      var redirectUri=window.location.origin+window.location.pathname;
      var verifier=genVerifier();
      challenge(verifier).then(function(chal){
        // Code client returns an auth code we exchange server-side (where the client secret lives)
        var client=google.accounts.oauth2.initCodeClient({
          client_id:GOOGLE_CLIENT_ID,
          scope:'https://www.googleapis.com/auth/drive.file',
          ux_mode:'popup',
          redirect_uri:redirectUri,
          access_type:'offline',  // request refresh token
          // Forces a fresh consent so Google returns a refresh_token (it won't on subsequent silent auths)
          prompt:'consent',
          code_challenge:chal,
          code_challenge_method:'S256',
          callback:function(resp){
            if(resp.error){reject(new Error(resp.error+(resp.error_description?': '+resp.error_description:'')));return;}
            callEdge('exchange',{code:resp.code,codeVerifier:verifier,redirectUri:redirectUri})
              .then(function(out){
                if(!out.access_token){reject(new Error('No access token returned. Re-try with a fresh consent.'));return;}
                setAccess(out.access_token,out.expires_in);
                resolve(out.access_token);
              })
              .catch(reject);
          },
          error_callback:function(err){
            var t=(err&&err.type)||'unknown';
            reject(new Error('OAuth failed ('+t+')'));
          }
        });
        client.requestCode();
      }).catch(reject);
    });
  }
  function ensureToken(){
    var t=getAccess();
    if(t)return Promise.resolve(t);
    // Try server-side refresh first; only re-auth if no stored credentials exist
    return callEdge('refresh',{}).then(function(out){
      if(!out.access_token)throw new Error('No token from refresh');
      setAccess(out.access_token,out.expires_in);
      return out.access_token;
    }).catch(function(e){
      // If no creds on server, the caller (UI) should prompt connect
      throw e;
    });
  }
  function api(path,opts){
    return ensureToken().then(function(tok){
      opts=opts||{};opts.headers=opts.headers||{};
      opts.headers.Authorization='Bearer '+tok;
      return fetch('https://www.googleapis.com/'+path,opts).then(function(r){
        if(r.status===401){clearAccess();throw new Error('Drive auth expired. Try again.');}
        if(!r.ok)return r.text().then(function(tx){throw new Error('Drive '+r.status+': '+tx);});
        return r;
      });
    });
  }
  function findOrCreateFolder(){
    var q="name='"+FOLDER_NAME+"' and mimeType='application/vnd.google-apps.folder' and trashed=false";
    return api('drive/v3/files?q='+encodeURIComponent(q)+'&fields=files(id,name)').then(function(r){return r.json();})
      .then(function(j){
        if(j.files&&j.files.length>0) return j.files[0].id;
        return api('drive/v3/files',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({name:FOLDER_NAME,mimeType:'application/vnd.google-apps.folder'})
        }).then(function(r){return r.json();}).then(function(f){return f.id;});
      });
  }
  function upload(dump){
    return findOrCreateFolder().then(function(folderId){
      var meta={name:'gavthan-backup-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json',parents:[folderId]};
      var boundary='-------'+Math.random().toString(36).slice(2);
      var body='--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(meta)+'\r\n'+
              '--'+boundary+'\r\nContent-Type: application/json\r\n\r\n'+JSON.stringify(dump)+'\r\n--'+boundary+'--';
      return api('upload/drive/v3/files?uploadType=multipart',{
        method:'POST',
        headers:{'Content-Type':'multipart/related; boundary='+boundary},
        body:body
      }).then(function(r){return r.json();});
    });
  }
  function list(){
    return findOrCreateFolder().then(function(folderId){
      var q="'"+folderId+"' in parents and trashed=false";
      return api('drive/v3/files?q='+encodeURIComponent(q)+'&orderBy=createdTime desc&fields=files(id,name,createdTime,size)')
        .then(function(r){return r.json();}).then(function(j){return j.files||[];});
    });
  }
  function download(fileId){
    return api('drive/v3/files/'+fileId+'?alt=media').then(function(r){return r.json();});
  }
  function checkStatus(){
    return callEdge('status',{}).then(function(out){return !!out.connected;}).catch(function(){return false;});
  }
  function disconnect(){
    clearAccess();
    return callEdge('disconnect',{}).catch(function(){/* ignore */});
  }
  function deleteFile(fileId){return callEdge('delete-backup',{fileId:fileId});}
  function deleteAll(){return callEdge('delete-all-backups',{confirm:true});}
  return {
    configured:configured,authorize:authorize,upload:upload,list:list,download:download,
    clearToken:clearAccess,getToken:getAccess,checkStatus:checkStatus,disconnect:disconnect,
    deleteFile:deleteFile,deleteAll:deleteAll
  };
})();

var INIT_CATS = ['Breakfast','Veg','Non-Veg','Bhakri','Chapati','Cold Drinks','Water Bottle','Glasses'];
var PALETTE   = [['#FAEEDA','#412402'],['#EAF3DE','#27500A'],['#FAECE7','#4A1B0C'],['#E6F1FB','#042C53'],['#EEEDFE','#26215C'],['#E1F5EE','#04342C'],['#FBEAF0','#4B1528'],['#FAE8E0','#3B1005']];
var INIT_MENU = [
  {id:'b1',cat:'Breakfast',name:'Poha',price:40},{id:'b2',cat:'Breakfast',name:'Upma',price:40},
  {id:'b3',cat:'Breakfast',name:'Idli Sambar',price:50},{id:'b4',cat:'Breakfast',name:'Misal Pav',price:60},
  {id:'b5',cat:'Breakfast',name:'Sabudana Khichdi',price:50},{id:'b6',cat:'Breakfast',name:'Puri Bhaji',price:60},
  {id:'b7',cat:'Breakfast',name:'Vada Pav',price:25},{id:'b8',cat:'Breakfast',name:'Sheera',price:35},
  {id:'v1',cat:'Veg',name:'Dal Fry',price:80},{id:'v2',cat:'Veg',name:'Paneer Bhaji',price:100},
  {id:'v3',cat:'Veg',name:'Usal',price:70},{id:'v4',cat:'Veg',name:'Aloo Sabzi',price:70},
  {id:'v5',cat:'Veg',name:'Dahi',price:30},{id:'v6',cat:'Veg',name:'Papad',price:15},
  {id:'n1',cat:'Non-Veg',name:'Egg Bhurji',price:70},{id:'n2',cat:'Non-Veg',name:'Omelette',price:60},
  {id:'n3',cat:'Non-Veg',name:'Chicken Curry',price:130},{id:'n4',cat:'Non-Veg',name:'Mutton Curry',price:160},
  {id:'n5',cat:'Non-Veg',name:'Fish Curry',price:120},
  {id:'k1',cat:'Bhakri',name:'Jowar Bhakri',price:15},{id:'k2',cat:'Bhakri',name:'Bajra Bhakri',price:15},
  {id:'c1',cat:'Chapati',name:'Chapati',price:10},{id:'c2',cat:'Chapati',name:'Butter Chapati',price:15},{id:'c3',cat:'Chapati',name:'Paratha',price:20},
  {id:'d1',cat:'Cold Drinks',name:'Coca Cola',price:40},{id:'d2',cat:'Cold Drinks',name:'Sprite',price:40},
  {id:'d3',cat:'Cold Drinks',name:'Maaza',price:35},{id:'d4',cat:'Cold Drinks',name:'Limca',price:40},
  {id:'w1',cat:'Water Bottle',name:'Water 1L',price:20},{id:'w2',cat:'Water Bottle',name:'Water 500ml',price:15},
  {id:'g1',cat:'Glasses',name:'Disposable Glass',price:5},{id:'g2',cat:'Glasses',name:'Tea Glass',price:3}
];

// ── SUPABASE INIT ──────────────────────────────────
// Normalize URL — strip /rest/v1/ or trailing slash if user copies wrong URL
var _rawUrl = (window.GH_CONFIG||{}).supabaseUrl || '';
SUPABASE_URL = _rawUrl.replace(/\/rest\/v1\/?$/,'').replace(/\/$/,'');
var isConfigured = !!(SUPABASE_URL && SUPABASE_KEY && SUPABASE_URL.indexOf('supabase.co')!==-1);
var supa = null;
var secSupa = null;
if(isConfigured){
  supa    = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  secSupa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY,
    {auth:{storageKey:'gh-sec',persistSession:false}});
}

// ── REACT ──────────────────────────────────────────
var h         = React.createElement;
var useState  = React.useState;
var useEffect = React.useEffect;
var useRef    = React.useRef;

// ── THEME (light / dark) ───────────────────────────
// Persisted in localStorage; first run follows the OS preference. Applied to
// <html data-theme> so the CSS variable palette in styles.css switches.
function getTheme(){
  try{var t=localStorage.getItem('gh-theme');if(t==='dark'||t==='light')return t;}catch(e){}
  return (window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light';
}
function applyTheme(t){
  document.documentElement.setAttribute('data-theme',t);
  var meta=document.querySelector('meta[name="theme-color"]');
  if(meta)meta.setAttribute('content',t==='dark'?'#1e1a15':'#ffffff');
}
applyTheme(getTheme()); // run at import time to avoid a flash of the wrong theme

function ThemeToggle(){
  var _t=useState(getTheme());var t=_t[0];var setT=_t[1];
  function flip(){
    var nx=t==='dark'?'light':'dark';
    try{localStorage.setItem('gh-theme',nx);}catch(e){}
    applyTheme(nx);setT(nx);
  }
  return h('button',{className:'theme-toggle',title:t==='dark'?'Switch to light mode':'Switch to dark mode',
    'aria-label':'Toggle theme',onClick:flip},t==='dark'?'☀':'☾');
}

// ── HELPERS ────────────────────────────────────────
function tot(items){return items.reduce(function(s,i){return s+i.price*i.qty;},0);}
// Raw items total
function rawTotal(cust){return tot(cust.items||[]);}
// Discount amount = % of raw total, only if discount checkbox on
function discountAmt(cust){
  if(cust.discount_on&&Number(cust.discount_pct)>0)
    return Math.round(rawTotal(cust)*Number(cust.discount_pct)/100);
  return 0;
}
// Flat adjustment, only if adjustment checkbox on
function adjustAmt(cust){
  return cust.adjustment_on?(Number(cust.adjustment)||0):0;
}
// Grand total = items − discount + adjustment
function finalTotal(cust){
  return rawTotal(cust)-discountAmt(cust)+adjustAmt(cust);
}
function clr(cat,cats){var i=cats.indexOf(cat);var p=PALETTE[(i<0?0:i)%PALETTE.length];return{bg:p[0],tx:p[1]};}
function todayStr(){return new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'2-digit',year:'numeric'});}
function timeStr(){return new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});}
function fmtDT(d){return new Date(d).toLocaleString('en-IN',{day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'});}
// Escape HTML special chars — prevents XSS when building bill markup from user input
function escHtml(s){
  return String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
// Mobile-safe print: open a fresh window containing ONLY the receipt and print from there.
// Avoids the broken hidden-iframe + DOM-injection paths (3rd-party Bluetooth printer apps
// re-render the parent DOM and capture the whole app). Must be called synchronously from a
// click handler so popup blockers allow it. Falls back to a download-as-HTML if blocked.
function printInNewWindow(title,css,bodyHtml){
  var html='<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>'+escHtml(title)+'</title><style>'+css+'</style></head><body>'+bodyHtml+'<script>window.onload=function(){setTimeout(function(){try{window.focus();window.print();}catch(e){}},250);};window.onafterprint=function(){setTimeout(function(){try{window.close();}catch(e){}},300);};<\/script></body></html>';
  var w=null;
  try{w=window.open('','_blank');}catch(e){}
  if(!w){
    // Popup blocked → fallback: download the receipt as a standalone HTML file the user can open & print.
    try{
      var blob=new Blob([html],{type:'text/html'});
      var url=URL.createObjectURL(blob);
      var a=document.createElement('a');
      a.href=url;a.download=title+'.html';
      document.body.appendChild(a);a.click();document.body.removeChild(a);
      setTimeout(function(){URL.revokeObjectURL(url);},1000);
      alert('Popup blocked. Receipt downloaded as HTML — open it and print from your browser.');
    }catch(e){alert('Print failed: popup blocked and download fallback errored ('+e.message+').');}
    return;
  }
  try{
    w.document.open();
    w.document.write(html);
    w.document.close();
  }catch(e){
    try{w.close();}catch(_){}
    alert('Print failed: '+e.message);
  }
}
// Format a bill number as INV-00001
function fmtBill(n){
  if(!n)return '';
  return 'INV-'+String(n).padStart(5,'0');
}
// Normalize an item's timestamps array (handles legacy data with just addedAt)
function itemTimes(it){
  if(Array.isArray(it.times)) return it.times;
  if(it.addedAt) return [it.addedAt];
  return [];
}
// Format a specific ISO timestamp (used for bill date — may be backdated)
function dateOf(iso){return new Date(iso).toLocaleDateString('en-IN',{day:'2-digit',month:'2-digit',year:'numeric'});}
function timeOf(iso){return new Date(iso).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});}
// The official, IMMUTABLE "Bill Date & Time" printed on every invoice surface
// (on-screen preview, WhatsApp/SMS text, PDF/JPEG/thermal/print, history & manager).
// settled_at is the single source of truth: frozen once at settle to the settle
// moment for normal bills, or the manually chosen backdate for backdated bills.
// Unsettled previews fall back to the order date until the bill is settled.
function billDateTime(c){return (c&&(c.settled_at||c.date))||null;}
function isAdminEmail(email){return ADMIN_EMAILS.indexOf((email||'').toLowerCase())!==-1;}
function initCap(s){return(s||'').toLowerCase().replace(/\b\w/g,function(c){return c.toUpperCase();});}
function todayCount(custs){var t=new Date().toDateString();return custs.filter(function(c){return new Date(c.date).toDateString()===t;}).length;}
function uuid(){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0;return(c==='x'?r:r&0x3|0x8).toString(16);});}

// Map known category names to a small icon. Falls back to a generic 🍽 for unknowns.
function catIcon(cat){
  var c=(cat||'').toLowerCase();
  if(c.indexOf('break')!==-1) return '🍳';
  if(c==='veg'||c.indexOf('veg')===0) return '🥗';
  if(c.indexOf('non')!==-1&&c.indexOf('veg')!==-1) return '🍗';
  if(c.indexOf('bhakri')!==-1) return '🌾';
  if(c.indexOf('chapati')!==-1||c.indexOf('roti')!==-1) return '🫓';
  if(c.indexOf('cold')!==-1||c.indexOf('drink')!==-1||c.indexOf('juice')!==-1||c.indexOf('soda')!==-1) return '🥤';
  if(c.indexOf('water')!==-1) return '💧';
  if(c.indexOf('glass')!==-1) return '🥃';
  if(c.indexOf('tea')!==-1) return '🍵';
  if(c.indexOf('coffee')!==-1) return '☕';
  if(c.indexOf('rice')!==-1||c.indexOf('biryani')!==-1) return '🍚';
  if(c.indexOf('dessert')!==-1||c.indexOf('sweet')!==-1) return '🍰';
  if(c.indexOf('snack')!==-1||c.indexOf('starter')!==-1) return '🍿';
  if(c.indexOf('soup')!==-1) return '🍲';
  if(c.indexOf('curry')!==-1) return '🍛';
  if(c.indexOf('seafood')!==-1||c.indexOf('fish')!==-1) return '🐟';
  if(c.indexOf('egg')!==-1) return '🥚';
  if(c.indexOf('cigarette')!==-1||c.indexOf('smoke')!==-1) return '🚬';
  return '🍽';
}
function Chip(props){var c=clr(props.cat,props.cats);return h('span',{className:'chip',title:props.cat,style:{background:c.bg,color:c.tx,padding:'2px 6px',fontSize:14,minWidth:24,textAlign:'center'}},catIcon(props.cat));}

// ── SUPABASE DATA LAYER ───────────────────────────
function sbErr(e){return e&&(e.message||e.details||JSON.stringify(e));}

function loadMenu(){
  return supa.from('mh_menu').select('*').order('sort_order',{ascending:true,nullsFirst:false}).order('name',{ascending:true}).then(function(r){
    if(r.error)throw new Error(sbErr(r.error));
    return r.data||[];
  });
}
function loadCats(){
  return supa.from('mh_categories').select('*').eq('id','main').maybeSingle().then(function(r){
    if(r.error)throw new Error(sbErr(r.error));
    return r.data?r.data.list:INIT_CATS;
  });
}
function loadCustomers(){
  return supa.from('mh_customers').select('*').order('created_at',{ascending:false}).then(function(r){
    if(r.error)throw new Error(sbErr(r.error));
    return (r.data||[]).map(function(c){return Object.assign({},c,{items:c.items||[]});});
  });
}
function loadUsers(){
  return supa.from('mh_users').select('*').then(function(r){
    if(r.error)throw new Error(sbErr(r.error));
    return r.data||[];
  });
}

// ── SETUP SCREEN ───────────────────────────────────
function SetupScreen(){
  var sql="-- Run this SQL in Supabase → SQL Editor:\n"
    +"create table if not exists mh_categories(id text primary key,list jsonb default '[]');\n"
    +"create table if not exists mh_menu(id text primary key,cat text,name text,price integer);\n"
    +"create table if not exists mh_customers(id text primary key,name text,room text,phone text default '',date timestamptz default now(),added_by text,items jsonb default '[]',status text default 'active',settled_at timestamptz,created_at timestamptz default now());\n"
    +"create table if not exists mh_users(id text primary key,email text,display_name text,role text default 'user',active boolean default true,created_at timestamptz default now());\n"
    +"-- Bill date columns: date=order/chosen-backdate; settled_at=IMMUTABLE official\n"
    +"-- Bill Date & Time and single source of truth (settle moment, or chosen backdate).\n"
    +"alter table mh_categories disable row level security;\n"
    +"alter table mh_menu disable row level security;\n"
    +"alter table mh_customers disable row level security;\n"
    +"alter table mh_users disable row level security;";
  return h('div',{className:'login-wrap'},
    h('div',{className:'login-box',style:{maxWidth:440}},
      h('div',{className:'login-logo'},h('em',null,'Gavthan')),
      h('div',{className:'login-sub'},'Supabase Setup Required'),
      h('div',{className:'setup-banner'},
        h('strong',null,'Step 1 — Create Supabase project:'),h('br',null),
        '1. Go to supabase.com → Sign up free',h('br',null),
        '2. New project → remember your DB password',h('br',null),
        '3. Project Settings → API → copy Project URL and anon/public key',h('br',null),
        '4. Paste into window.GH_CONFIG in this file',h('br',null),h('br',null),
        h('strong',null,'Step 2 — Create tables (run in Supabase → SQL Editor):'),h('br',null),
        h('code',{style:{display:'block',background:'var(--surface)',padding:'8px',borderRadius:4,margin:'6px 0',fontSize:10,lineHeight:1.5,whiteSpace:'pre',overflowX:'auto'}},sql)
      )
    )
  );
}

// ── LOGIN SCREEN ───────────────────────────────────
function LoginScreen(props){
  var onLogin=props.onLogin;
  var _mode=useState('login');var mode=_mode[0];var setMode=_mode[1];
  var _email=useState('');var email=_email[0];var setEmail=_email[1];
  var _pass=useState('');var pass=_pass[0];var setPass=_pass[1];
  var _name=useState('');var name=_name[0];var setName=_name[1];
  var _err=useState('');var err=_err[0];var setErr=_err[1];
  var _busy=useState(false);var busy=_busy[0];var setBusy=_busy[1];
  var _confirmMsg=useState('');var confirmMsg=_confirmMsg[0];var setConfirmMsg=_confirmMsg[1];

  function doAuth(){
    if(!email.trim()||!pass){setErr('Email and password required.');return;}
    setBusy(true);setErr('');setConfirmMsg('');
    supa.auth.signInWithPassword({email:email.trim(),password:pass})
      .then(function(r){
        if(r.error){
          if(r.error.message.toLowerCase().indexOf('email')!==-1&&r.error.message.toLowerCase().indexOf('confirm')!==-1){
            setErr('Please confirm your email first. Check your inbox for the confirmation link.');
          } else {
            setErr(r.error.message);
          }
          setBusy(false);return;
        }
        var u=r.data.user;
        return supa.from('mh_users').select('*').eq('id',u.id).maybeSingle()
          .then(function(rr){
            if(rr.error) throw new Error(rr.error.message);
            if(!rr.data){
              // First-time login — auto-create mh_users record (pending unless bootstrap admin)
              var role=isAdminEmail(u.email)?'admin':'user';
              var dn=(u.user_metadata&&u.user_metadata.display_name)||u.email.split('@')[0];
              return supa.from('mh_users').insert({id:u.id,email:u.email,display_name:dn,role:role,active:isAdminEmail(u.email)})
                .then(function(){
                  if(!isAdminEmail(u.email)){
                    supa.auth.signOut();
                    setErr('Account created — awaiting admin approval. You will be able to login once approved.');
                    setBusy(false);
                  }
                });
            }
            if(rr.data.active===false){
              supa.auth.signOut();
              setErr(rr.data.role==='deleted'
                ?'Your account has been removed. Contact admin.'
                :'Account awaiting admin approval. Please try again later.');
              setBusy(false);
            }
          });
      })
      .catch(function(e){setErr(e.message);setBusy(false);});
  }

  function doForgot(){
    var em=(email.trim()||prompt('Enter your registered email:')||'').trim();
    if(!em)return;
    setBusy(true);setErr('');setConfirmMsg('');
    supa.auth.resetPasswordForEmail(em).then(function(r){
      setBusy(false);
      if(r&&r.error){setErr('Error: '+r.error.message);return;}
      setConfirmMsg('✓ Password reset email sent to '+em+'. Check your inbox for the reset link.');
    }).catch(function(e){setBusy(false);setErr(e.message);});
  }
  function onKey(e){if(e.key==='Enter')doAuth();}

  return h('div',{className:'login-wrap'},
    h('div',{className:'login-box'},
      h('div',{className:'login-logo'},h('em',null,'Gavthan')),
      h('div',{className:'login-sub'},'Staff Login'),
      confirmMsg
        ? h('div',null,
            h('div',{className:'msg-ok',style:{lineHeight:1.7}},confirmMsg),
            h('button',{className:'btn btn-a',style:{width:'100%',justifyContent:'center',marginTop:8},
              onClick:function(){setConfirmMsg('');}},'Back to Login')
          )
        : h('div',null,
            err&&h('div',{className:'msg-err'},err),
            h('div',{className:'fld'},h('label',null,'Email'),
              h('input',{type:'email',value:email,onChange:function(e){setEmail(e.target.value);},placeholder:'you@example.com',onKeyDown:onKey})),
            h('div',{className:'fld',style:{marginBottom:16}},h('label',null,'Password'),
              h('input',{type:'password',value:pass,onChange:function(e){setPass(e.target.value);},placeholder:'Your password',onKeyDown:onKey})),
            h('button',{className:'btn btn-a',style:{width:'100%',justifyContent:'center',marginBottom:8},onClick:doAuth,disabled:busy},
              busy&&h('span',{className:'spin'}),'Login'),
            h('div',{style:{textAlign:'center',fontSize:11,marginBottom:6}},
              h('span',{style:{color:'#B45309',cursor:'pointer',fontWeight:600},onClick:doForgot},'Forgot password?')
            ),
            h('div',{style:{textAlign:'center',fontSize:11,color:'var(--text-2)'}},
              'No account? Ask your admin to create one for you.'
            )
          )
    )
  );
}

// ── MAIN APP ───────────────────────────────────────
function App(props){
  var user=props.user;
  // Dynamic admin check: prefer DB role (mh_users.role), fallback to GH_ADMINS for bootstrap
  var admin=isAdminEmail(user.email);
  var _tab=useState('orders');var tab=_tab[0];var setTab=_tab[1];
  var _cats=useState(INIT_CATS);var cats=_cats[0];var setCats=_cats[1];
  var _menu=useState([]);var menu=_menu[0];var setMenu=_menu[1];
  var _custs=useState([]);var custs=_custs[0];var setCusts=_custs[1];
  var _users=useState([]);var users=_users[0];var setUsers=_users[1];
  var _selId=useState(null);var selId=_selId[0];var setSelId=_selId[1];
  var _billId=useState(null);var billId=_billId[0];var setBillId=_billId[1];
  // Preview bill number — peeks at lastBillNo+1 from config; only used for unsettled previews
  var _previewBN=useState(null);var previewBillNo=_previewBN[0];var setPreviewBillNo=_previewBN[1];
  var _dbOk=useState(null);var dbOk=_dbOk[0];var setDbOk=_dbOk[1];
  var _err=useState('');var appErr=_err[0];var setAppErr=_err[1];
  var _menuErr=useState('');var menuErr=_menuErr[0];var setMenuErr=_menuErr[1];
  var _myUser=useState(null);var myUser=_myUser[0];var setMyUser=_myUser[1];
  var _timeout=useState(30);var sessionTimeout=_timeout[0];var setSessionTimeout=_timeout[1];
  // UPI ID for bills — DB-configurable (mh_config.app.data.upiId), falls back to the build-time constant
  var _upi=useState(UPI_ID);var upiId=_upi[0];var setUpiId=_upi[1];

  // ── Fetch all data from Supabase ──
  function fetchAll(silent){
    loadMenu()
      .then(function(d){setMenuErr('');setMenu(d);setDbOk(true);})
      .catch(function(e){setMenuErr('Menu error: '+e.message);setDbOk(false);});
    loadCats().then(setCats).catch(function(){});
    loadCustomers().then(setCusts).catch(function(e){setAppErr('Customers: '+e.message);});
    if(admin) loadUsers().then(setUsers).catch(function(){});
  }

  // ── Seed default data if tables are empty ──
  function seed(){
    supa.from('mh_menu').select('id').limit(1).then(function(r){
      if(!r.error&&(!r.data||r.data.length===0)){
        var rows=INIT_MENU.map(function(m){return{id:m.id,cat:m.cat,name:m.name,price:m.price};});
        supa.from('mh_menu').insert(rows).then(function(){});
        supa.from('mh_categories').upsert({id:'main',list:INIT_CATS}).then(function(){});
      }
    });
  }

  useEffect(function(){
    seed();
    fetchAll(true);
    // Fetch current user's record for display name
    supa.from('mh_users').select('*').eq('id',user.id).maybeSingle()
      .then(function(r){ if(r.data) setMyUser(r.data); }, function(){});
    // Fetch app config (session timeout)
    function loadConfig(){
      supa.from('mh_config').select('data').eq('id','app').maybeSingle()
        .then(function(r){
          var d=r.data&&r.data.data;
          if(d&&d.sessionTimeout)
            setSessionTimeout(Number(d.sessionTimeout)||30);
          if(d&&typeof d.upiId==='string')
            setUpiId(d.upiId);
        },function(){});
    }
    loadConfig();
    var cfgT=setInterval(loadConfig,60000); // refresh config each minute
    // Heartbeat — update last_seen_at every 30s so admin can see who's online
    function heartbeat(){
      supa.from('mh_users').update({last_seen_at:new Date().toISOString()}).eq('id',user.id)
        .then(function(){}, function(){}); // silently ignore if column missing
    }
    heartbeat();
    var hb=setInterval(heartbeat,30000);
    // Poll every 5s for live updates across devices
    var t=setInterval(fetchAll,5000);
    return function(){clearInterval(t);clearInterval(hb);clearInterval(cfgT);};
  },[]);

  // ── Idle auto-logout with warning ──
  var _idleWarn=useState(false);var idleWarn=_idleWarn[0];var setIdleWarn=_idleWarn[1];
  useEffect(function(){
    if(!sessionTimeout||sessionTimeout<=0)return;
    var idleMs=sessionTimeout*60*1000;
    var warnMs=Math.max(0,idleMs-60*1000); // warn 1 minute before
    var timer,wtimer;
    function logout(){
      supa.auth.signOut();
    }
    function reset(){
      clearTimeout(timer);clearTimeout(wtimer);
      setIdleWarn(false);
      wtimer=setTimeout(function(){setIdleWarn(true);},warnMs);
      timer=setTimeout(logout,idleMs);
    }
    var evts=['mousemove','mousedown','keydown','touchstart','scroll','click'];
    evts.forEach(function(e){window.addEventListener(e,reset,{passive:true});});
    reset();
    return function(){
      clearTimeout(timer);clearTimeout(wtimer);
      evts.forEach(function(e){window.removeEventListener(e,reset);});
    };
  },[sessionTimeout]);

  // ── Online/offline detection ──
  var _online=useState(navigator.onLine!==false);var online=_online[0];var setOnline=_online[1];
  useEffect(function(){
    function up(){setOnline(true);}
    function down(){setOnline(false);}
    window.addEventListener('online',up);
    window.addEventListener('offline',down);
    return function(){window.removeEventListener('online',up);window.removeEventListener('offline',down);};
  },[]);

  function backupDatabase(silent){
    return Promise.all([
      supa.from('mh_categories').select('*'),
      supa.from('mh_menu').select('*'),
      supa.from('mh_customers').select('*'),
      supa.from('mh_users').select('*'),
      supa.from('mh_config').select('*')
    ]).then(function(res){
      for(var i=0;i<res.length;i++){if(res[i].error)throw new Error(sbErr(res[i].error));}
      var dump={
        exportedAt:new Date().toISOString(),
        hotel:HOTEL_NAME,
        version:1,
        categories:res[0].data||[],
        menu:res[1].data||[],
        customers:res[2].data||[],
        users:res[3].data||[],
        config:res[4].data||[]
      };
      if(!silent){
        var blob=new Blob([JSON.stringify(dump,null,2)],{type:'application/json'});
        var url=URL.createObjectURL(blob);
        var a=document.createElement('a');
        a.href=url;a.download='gavthan-backup-'+new Date().toISOString().slice(0,10)+'.json';
        document.body.appendChild(a);a.click();document.body.removeChild(a);
        setTimeout(function(){URL.revokeObjectURL(url);},1000);
      }
      return dump;
    });
  }

  // ── Auto Google Drive backup ──
  var _driveInterval=useState('off');var driveInterval=_driveInterval[0];var setDriveInterval=_driveInterval[1];
  var _driveLast=useState(null);var driveLast=_driveLast[0];var setDriveLast=_driveLast[1];
  // Load drive settings from config
  useEffect(function(){
    supa.from('mh_config').select('data').eq('id','app').maybeSingle().then(function(r){
      if(r.data&&r.data.data){
        if(r.data.data.driveInterval) setDriveInterval(r.data.data.driveInterval);
        if(r.data.data.driveLast) setDriveLast(r.data.data.driveLast);
      }
    },function(){});
  },[]);
  // Periodic check (every 5 minutes) — runs auto-backup if interval elapsed
  useEffect(function(){
    if(driveInterval==='off'||!Drive.configured())return;
    var intMs={daily:86400e3,weekly:7*86400e3,monthly:30*86400e3}[driveInterval]||0;
    if(!intMs)return;
    function check(){
      var last=driveLast?new Date(driveLast).getTime():0;
      if(Date.now()-last<intMs)return;
      if(!Drive.getToken())return; // skip silent run if not authorized
      backupDatabase(true).then(function(dump){return Drive.upload(dump);}).then(function(){
        var nowIso=new Date().toISOString();
        setDriveLast(nowIso);
        return supa.from('mh_config').select('data').eq('id','app').maybeSingle().then(function(r){
          var cfg=(r.data&&r.data.data)||{};cfg.driveLast=nowIso;
          return supa.from('mh_config').upsert({id:'app',data:cfg});
        });
      }).catch(function(e){console.error('Auto backup failed:',e);});
    }
    check();
    var t=setInterval(check,5*60*1000);
    return function(){clearInterval(t);};
  },[driveInterval,driveLast]);

  function saveDriveInterval(iv){
    setDriveInterval(iv);
    supa.from('mh_config').select('data').eq('id','app').maybeSingle().then(function(r){
      var cfg=(r.data&&r.data.data)||{};cfg.driveInterval=iv;
      return supa.from('mh_config').upsert({id:'app',data:cfg});
    }).catch(showErr);
  }

  function restoreFromBackup(dump,onLog){
    function log(msg){if(onLog)onLog(msg);console.log('[restore]',msg);}
    if(!dump||typeof dump!=='object'){return Promise.reject(new Error('Invalid backup file.'));}
    var cats=dump.categories||[];
    var menu=dump.menu||[];
    var custs=dump.customers||[];
    var usrs=dump.users||[];
    var cfg=dump.config||[];

    // Integrity: collect every category referenced by menu items; auto-add missing ones
    var catRow=cats.find(function(r){return r.id==='main';})||{id:'main',list:[]};
    var catList=Array.isArray(catRow.list)?catRow.list.slice():[];
    menu.forEach(function(m){
      if(m.cat&&catList.indexOf(m.cat)===-1){catList.push(m.cat);log('Auto-added missing category: '+m.cat);}
    });
    catRow.list=catList;

    // Integrity: customers reference items snapshot, so no FK to menu needed.
    // Sanity-fill missing fields so inserts don't fail on NOT NULL.
    custs.forEach(function(c){
      if(!c.status) c.status='settled';
      if(!c.items) c.items=[];
      if(!c.date) c.date=new Date().toISOString();
      if(!c.added_by) c.added_by='restored@backup';
    });

    log('Restoring '+catList.length+' categories, '+menu.length+' items, '+custs.length+' orders, '+usrs.length+' users…');
    var ops=[
      supa.from('mh_categories').upsert(catRow),
      menu.length?supa.from('mh_menu').upsert(menu):Promise.resolve({error:null}),
      custs.length?supa.from('mh_customers').upsert(custs):Promise.resolve({error:null}),
      usrs.length?supa.from('mh_users').upsert(usrs):Promise.resolve({error:null}),
      cfg.length?supa.from('mh_config').upsert(cfg):Promise.resolve({error:null})
    ];
    return Promise.all(ops).then(function(rs){
      var errs=[];
      ['categories','menu','customers','users','config'].forEach(function(nm,i){
        if(rs[i]&&rs[i].error){errs.push(nm+': '+sbErr(rs[i].error));}
      });
      if(errs.length){log('Errors: '+errs.join('; '));throw new Error(errs.join('\n'));}
      log('Restore complete.');
      return fetchAll();
    });
  }

  function saveSessionTimeout(mins){
    var m=Math.max(1,Number(mins)||30);
    setSessionTimeout(m);
    // Merge into existing config so other keys (lastBillNo) aren't wiped
    supa.from('mh_config').select('data').eq('id','app').maybeSingle()
      .then(function(r){
        var cfg=(r.data&&r.data.data)||{};
        cfg.sessionTimeout=m;
        return supa.from('mh_config').upsert({id:'app',data:cfg});
      })
      .then(function(r){if(r&&r.error)showErr(new Error(sbErr(r.error)));})
      .catch(showErr);
  }

  function saveUpiId(val){
    var v=(val||'').trim();
    setUpiId(v);
    // Merge into existing config so other keys (sessionTimeout, lastBillNo) aren't wiped
    supa.from('mh_config').select('data').eq('id','app').maybeSingle()
      .then(function(r){
        var cfg=(r.data&&r.data.data)||{};
        cfg.upiId=v;
        return supa.from('mh_config').upsert({id:'app',data:cfg});
      })
      .then(function(r){if(r&&r.error)showErr(new Error(sbErr(r.error)));})
      .catch(showErr);
  }

  function showErr(e){setAppErr(e.message||String(e));}

  // ── Customer ops ──
  function addCust(name,room,phone,dateISO){
    var id=uuid();
    var d=dateISO||new Date().toISOString();
    var row={id:id,name:name,room:room,phone:phone,date:d,
      added_by:user.email,items:[],status:'active',created_at:new Date().toISOString()};
    supa.from('mh_customers').insert(row)
      .then(function(r){if(r.error)throw new Error(sbErr(r.error));return fetchAll();})
      .then(function(){setSelId(id);setTab('orders');})
      .catch(showErr);
  }
  function updateCustomer(cid,fields){
    setCusts(function(prev){return prev.map(function(c){return c.id===cid?Object.assign({},c,fields):c;});});
    supa.from('mh_customers').update(fields).eq('id',cid)
      .then(function(r){if(r.error)throw new Error(sbErr(r.error));})
      .catch(function(e){showErr(e);fetchAll();});
  }
  function upsertItem(cid,mid,delta){
    // Re-fetch the latest row first so two staff editing the same order don't overwrite each other
    supa.from('mh_customers').select('items').eq('id',cid).maybeSingle()
      .then(function(r){
        var live=(r.data&&r.data.items)||[];
        var items=live.slice();
        var idx=items.findIndex(function(i){return i.id===mid;});
        var nowIso=new Date().toISOString();
        if(idx!==-1){
          var ex=items[idx];
          var times=itemTimes(ex).slice();
          if(delta>0){ for(var k=0;k<delta;k++) times.push(nowIso); }
          else { for(var j=0;j<-delta;j++) times.pop(); }
          items[idx]=Object.assign({},ex,{qty:times.length,times:times});
          delete items[idx].addedAt; // drop legacy field
          items=items.filter(function(i){return (i.qty||0)>0;});
        } else {
          var mi=menu.find(function(m){return m.id===mid;});
          if(!mi||delta<1)return;
          items.push({id:mi.id,name:mi.name,cat:mi.cat,price:mi.price,qty:delta,times:Array.apply(null,{length:delta}).map(function(){return nowIso;})});
        }
        setCusts(function(p){return p.map(function(c){return c.id===cid?Object.assign({},c,{items:items}):c;});});
        return supa.from('mh_customers').update({items:items,updated_at:nowIso}).eq('id',cid);
      })
      .then(function(r){if(r&&r.error)throw new Error(sbErr(r.error));})
      .catch(function(e){showErr(e);fetchAll();});
  }
  function settle(cid){
    var cust=custs.find(function(c){return c.id===cid;});
    if(!cust)return;
    if(!admin&&cust.added_by!==user.email){alert('You can only settle your own orders. Ask an admin.');return;}
    if(finalTotal(cust)===0){alert('Cannot settle zero-amount bill. Add items first.');return;}
    if((cust.discount_on||cust.adjustment_on)&&!(cust.reason||'').trim()){
      alert('A Reason is required when Discount or Adjustment is applied. Please fill the Reason field.');return;
    }
    if(!confirm('Settle this customer?'))return;
    // settled_at = the official, immutable "Bill Date & Time" and single source of
    // truth. Frozen ONCE here and never recomputed:
    //   • backdated order  → lock to the manually chosen creation date (cust.date)
    //   • same-day order   → the settle moment (now)
    var orderDate=cust.date?new Date(cust.date):new Date();
    var isBackdated=orderDate.toDateString()!==new Date().toDateString();
    var settledAt=isBackdated?orderDate.toISOString():new Date().toISOString();
    // Assign a sequential bill number from the mh_config counter
    supa.from('mh_config').select('data').eq('id','app').maybeSingle()
      .then(function(r){
        var cfg=(r.data&&r.data.data)||{};
        var nextNo=(Number(cfg.lastBillNo)||0)+1;
        cfg.lastBillNo=nextNo;
        return supa.from('mh_config').upsert({id:'app',data:cfg}).then(function(){return nextNo;});
      })
      .then(function(nextNo){
        return supa.from('mh_customers').update({status:'settled',settled_at:settledAt,bill_no:nextNo}).eq('id',cid);
      })
      .then(function(r){if(r.error)throw new Error(sbErr(r.error));return fetchAll();})
      .then(function(){if(selId===cid)setSelId(null);})
      .catch(showErr);
  }
  function delCust(cid){
    var cust=custs.find(function(c){return c.id===cid;});
    if(!cust)return;
    if(!admin&&cust.added_by!==user.email){alert('You can only delete your own orders. Ask an admin.');return;}
    if(!confirm('Delete this record?'))return;
    supa.from('mh_customers').delete().eq('id',cid)
      .then(function(r){if(r.error)throw new Error(sbErr(r.error));return fetchAll();})
      .then(function(){if(selId===cid)setSelId(null);})
      .catch(showErr);
  }
  function setDiscount(cid,pct){
    var p=Number(pct)||0;
    var on=p>0;
    setCusts(function(prev){return prev.map(function(c){return c.id===cid?Object.assign({},c,{discount_on:on,discount_pct:p}):c;});});
    supa.from('mh_customers').update({discount_on:on,discount_pct:p}).eq('id',cid)
      .then(function(r){if(r.error)throw new Error(sbErr(r.error));})
      .catch(function(e){showErr(e);fetchAll();});
  }
  function setAdjustment(cid,amt){
    var n=Number(amt)||0;
    var on=n!==0;
    setCusts(function(prev){return prev.map(function(c){return c.id===cid?Object.assign({},c,{adjustment_on:on,adjustment:n}):c;});});
    supa.from('mh_customers').update({adjustment_on:on,adjustment:n}).eq('id',cid)
      .then(function(r){if(r.error)throw new Error(sbErr(r.error));})
      .catch(function(e){showErr(e);fetchAll();});
  }

  // ── Menu ops ──
  function addMenuItem(cat,name,price){
    var row={id:uuid(),cat:cat,name:name,price:parseInt(price)};
    supa.from('mh_menu').insert(row)
      .then(function(r){if(r.error)throw new Error(sbErr(r.error));return fetchAll();})
      .catch(showErr);
  }
  function updateMenuItem(id,name,price){
    supa.from('mh_menu').update({name:name,price:parseInt(price)}).eq('id',id)
      .then(function(r){if(r.error)throw new Error(sbErr(r.error));return fetchAll();})
      .catch(showErr);
  }
  function deleteMenuItem(id){
    supa.from('mh_menu').delete().eq('id',id)
      .then(function(r){if(r.error)throw new Error(sbErr(r.error));return fetchAll();})
      .catch(showErr);
  }
  function toggleMenuAvail(id,avail){
    supa.from('mh_menu').update({available:avail}).eq('id',id)
      .then(function(r){if(r.error)throw new Error(sbErr(r.error));return fetchAll();})
      .catch(showErr);
  }
  function saveCats(newCats,oldCat,newCat){
    supa.from('mh_categories').upsert({id:'main',list:newCats})
      .then(function(r){if(r.error)throw new Error(sbErr(r.error));return fetchAll();})
      .catch(showErr);
    if(oldCat&&newCat&&oldCat!==newCat){
      supa.from('mh_menu').update({cat:newCat}).eq('cat',oldCat)
        .then(function(){fetchAll();}).catch(showErr);
    }
    if(!newCat&&oldCat){
      supa.from('mh_menu').delete().eq('cat',oldCat)
        .then(function(){fetchAll();}).catch(showErr);
    }
  }
  // Batch-update sort_order for a list of item ids in the given order. Issues one update
  // per row (Supabase has no bulk-conditional-update); refreshes once at the end.
  function reorderItems(orderedIds){
    if(!orderedIds||!orderedIds.length){return;}
    var ps=orderedIds.map(function(id,idx){
      return supa.from('mh_menu').update({sort_order:idx}).eq('id',id);
    });
    Promise.all(ps).then(function(rs){
      for(var i=0;i<rs.length;i++){if(rs[i]&&rs[i].error)throw new Error(sbErr(rs[i].error));}
      return fetchAll();
    }).catch(showErr);
  }

  // ── User management ──
  function addUser(newEmail,newPass,newName,cb){
    var email=(newEmail||'').trim();
    var pass=newPass||'';
    var name=(newName||'').trim();
    if(!email||!pass||!name){cb('Email, password, and name are all required.');return;}
    var role=isAdminEmail(email)?'admin':'user';
    // Server-side atomic creation via user-admin Edge Function: handles dangling auth users,
    // missing mh_users rows, and rolls back on partial failure so retry is always safe.
    supa.auth.getSession().then(function(r){
      var jwt=r&&r.data&&r.data.session&&r.data.session.access_token;
      if(!jwt) throw new Error('Not signed in.');
      var url=((window.GH_CONFIG||{}).supabaseUrl||'').replace(/\/rest\/v1\/?$/,'').replace(/\/$/,'')+'/functions/v1/user-admin';
      return fetch(url,{
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+jwt,'apikey':SUPABASE_KEY},
        body:JSON.stringify({action:'create-user',email:email,password:pass,displayName:name,role:role})
      }).then(function(rs){return rs.json().then(function(j){
        if(!rs.ok) throw new Error(j.error||('HTTP '+rs.status));
        return j;
      });});
    }).then(function(j){
      fetchAll();
      var note=j.reused?' (linked to an existing auth account that was missing its app profile)':'';
      cb(null,'User "'+name+'" added!'+note);
    }).catch(function(e){console.error('[addUser]',e);cb(e.message);});
  }
  function toggleUserActive(id,current){
    supa.from('mh_users').update({active:!current}).eq('id',id)
      .then(function(){fetchAll();}).catch(showErr);
  }
  function changeUserRole(id,newRole){
    supa.from('mh_users').update({role:newRole}).eq('id',id)
      .then(function(){fetchAll();}).catch(showErr);
  }
  function deleteUser(id,email){
    if(!confirm('Delete user "'+email+'" PERMANENTLY?\n\nThis fully removes them from Supabase Auth and the app. The same email can re-signup afterwards.'))return;
    supa.auth.getSession().then(function(r){
      var jwt=r&&r.data&&r.data.session&&r.data.session.access_token;
      if(!jwt) throw new Error('Not signed in.');
      var url=((window.GH_CONFIG||{}).supabaseUrl||'').replace(/\/rest\/v1\/?$/,'').replace(/\/$/,'')+'/functions/v1/user-admin';
      return fetch(url,{
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+jwt,'apikey':SUPABASE_KEY},
        body:JSON.stringify({action:'delete-user',userId:id})
      }).then(function(rs){return rs.json().then(function(j){if(!rs.ok) throw new Error(j.error||('HTTP '+rs.status)); return j;});});
    }).then(function(){
      fetchAll();
      alert('User fully removed. The email can now be used to re-signup.');
    }).catch(showErr);
  }
  function sendReset(email){
    supa.auth.resetPasswordForEmail(email)
      .then(function(){alert('Password reset email sent to '+email);})
      .catch(function(e){alert('Error: '+e.message);});
  }
  function logout(){
    supa.auth.signOut().then(function(){setTab('orders');setSelId(null);setBillId(null);});
  }

  var active=admin
    ? custs.filter(function(c){return c.status==='active';})
    : custs.filter(function(c){return c.status==='active'&&c.added_by===user.email;});
  var settled=custs.filter(function(c){return c.status==='settled';});
  var todaySett=settled.filter(function(c){return c.settled_at&&new Date(c.settled_at).toDateString()===new Date().toDateString();});
  var todayRev=todaySett.reduce(function(s,c){return s+finalTotal(c);},0);
  var billCust=billId?custs.find(function(c){return c.id===billId;}):null;
  // Fetch preview bill number whenever the bill modal opens for an unsettled order
  useEffect(function(){
    if(!billId){setPreviewBillNo(null);return;}
    var c=custs.find(function(x){return x.id===billId;});
    if(c&&(c.bill_no||c.status==='settled')){setPreviewBillNo(null);return;} // settled = locked, never preview
    supa.from('mh_config').select('data').eq('id','app').maybeSingle()
      .then(function(r){
        var cfg=(r.data&&r.data.data)||{};
        setPreviewBillNo((Number(cfg.lastBillNo)||0)+1);
      },function(){setPreviewBillNo(null);});
  },[billId]);
  // Dynamic admin: DB role takes precedence over hardcoded list
  if(myUser&&myUser.role==='admin') admin=true;
  if(myUser&&myUser.role==='user') admin=false;

  var displayName=initCap(
    (myUser&&myUser.display_name) ||
    (user.user_metadata&&user.user_metadata.display_name) ||
    user.email.split('@')[0]
  );
  var tabs=[['orders','Orders'],['new','+'],['history','History']];
  // admin = role-based (includes promoted admins) → Menu, Cust
  // superAdmin = strictly GH_ADMINS seeded emails → Users tab only
  var superAdmin=isAdminEmail(user.email);
  if(admin){tabs.push(['menu','Menu']);tabs.push(['customers','Cust']);tabs.push(['manager','Manager']);}
  if(superAdmin){tabs.push(['users','Config']);}

  return h('div',{className:'wrap'},
    !online&&h('div',{style:{background:'#991B1B',color:'#fff',padding:'6px 12px',fontSize:12,fontWeight:600,textAlign:'center'}},
      '⚠ You are offline — changes will not be saved until the connection returns.'),
    idleWarn&&online&&h('div',{style:{background:'#B45309',color:'#fff',padding:'6px 12px',fontSize:12,fontWeight:600,textAlign:'center'}},
      '⏱ You will be logged out in 1 minute due to inactivity. Move the mouse or tap to stay signed in.'),
    h('div',{className:'hdr'},
      h('div',{className:'logo'},h('em',null,'Gavthan')),
      h('div',{className:'nav'},tabs.map(function(t){
        return h('button',{key:t[0],className:'nb'+(tab===t[0]?' on':''),onClick:function(){setTab(t[0]);}},t[1]);
      })),
      h('div',{style:{display:'flex',alignItems:'center',gap:6,marginLeft:'auto',flexShrink:0}},
        h('span',{title:dbOk===null?'Connecting…':dbOk?'DB Connected':'DB Error',
          style:{width:8,height:8,borderRadius:'50%',flexShrink:0,
            background:dbOk===null?'#d1d5db':dbOk?'#22c55e':'#ef4444',
            boxShadow:dbOk?'0 0 4px #22c55e':'none'}}),
        h('span',{style:{fontSize:12,color:'var(--text-2)',whiteSpace:'nowrap'}},'Hi ',h('strong',null,displayName)),
        h('span',{className:admin?'badge-admin':'badge-user'},admin?'Admin':'Staff'),
        h(ThemeToggle,null),
        h('button',{className:'btn xs btn-r',onClick:logout},'⏻ Sign Out')
      )
    ),
    h('div',{className:'body'},
      appErr&&h('div',{style:{background:'#FEF2F2',color:'#991B1B',border:'1px solid #FECACA',borderRadius:8,padding:'10px 12px',marginBottom:8,fontSize:12,lineHeight:1.7},onClick:function(){setAppErr('');}},
        h('strong',null,'⚠️ Error — '),appErr,h('span',{style:{float:'right',cursor:'pointer',fontWeight:700}},'✕')),
      tab==='orders'  &&h(OrdersTab,  {active,menu,cats,selId,setSelId,upsertItem,settle,delCust,setBillId,menuErr,setDiscount,setAdjustment,updateCustomer}),
      tab==='new'     &&h(NewTab,     {addCust,todayCnt:todayCount(custs),allCusts:custs,admin}),
      tab==='history' &&h(HistoryTab, {settled,todayRev,todaySett,cats,setBillId,delCust,admin,userEmail:user.email,users}),
      tab==='menu'    &&admin&&h(MenuTab,{cats,saveCats,menu,addMenuItem,updateMenuItem,deleteMenuItem,toggleMenuAvail,reorderItems}),
      tab==='customers'&&admin&&h(CustomersTab,{custs}),
      tab==='manager' &&admin&&h(ManagerTab,{custs,cats,users}),
      tab==='users'   &&superAdmin&&h(UsersTab,{users,currentUid:user.id,currentEmail:user.email,superAdmin:superAdmin,addUser,toggleUserActive,changeUserRole,sendReset,deleteUser,sessionTimeout,saveSessionTimeout,upiId,saveUpiId,backupDatabase,restoreFromBackup,driveInterval,saveDriveInterval,driveLast})
    ),
    billCust&&h(BillModal,{cust:billCust,cats,previewBillNo:previewBillNo,upiId:upiId,onClose:function(){setBillId(null);},
      updateCustomer:updateCustomer,
      onSavePhone:function(ph){
        supa.from('mh_customers').update({phone:ph}).eq('id',billCust.id)
          .then(function(r){if(r.error)showErr(new Error(sbErr(r.error)));else fetchAll();});
      }
    })
  );
}

// ── ORDERS TAB ─────────────────────────────────────
function OrdersTab(props){
  var active=props.active,menu=props.menu,cats=props.cats,selId=props.selId,setSelId=props.setSelId;
  var upsertItem=props.upsertItem,settle=props.settle,delCust=props.delCust,setBillId=props.setBillId,menuErr=props.menuErr||'';
  var _q=useState('');var q=_q[0];var setQ=_q[1];
  var list=active.filter(function(c){return c.name.toLowerCase().indexOf(q.toLowerCase())!==-1||c.room.toLowerCase().indexOf(q.toLowerCase())!==-1;});
  return h('div',null,
    menuErr&&h('div',{style:{background:'#FEF2F2',color:'#991B1B',border:'1px solid #FECACA',borderRadius:8,padding:'10px 12px',marginBottom:8,fontSize:12}},menuErr),
    h('input',{placeholder:'Search customer / room…',value:q,onChange:function(e){setQ(e.target.value);},style:{marginBottom:8}}),
    list.length===0&&h('div',{className:'empty card'},'No active customers. Tap + to add.'),
    list.map(function(c){
      return h('div',{key:c.id,className:'ccard'+(c.id===selId?' sel':''),onClick:function(){setSelId(c.id===selId?null:c.id);}},
        h('div',{className:'row bw'},
          h('div',null,h('div',{style:{fontWeight:700}},c.name),h('div',{className:'muted',style:{fontSize:11}},c.room+(c.phone?' · '+c.phone:''))),
          h('div',{style:{textAlign:'right'}},h('div',{style:{fontWeight:700,color:'#B45309'}},'₹'+finalTotal(c)),h('div',{className:'muted',style:{fontSize:10}},fmtDT(c.date)))
        ),
        c.id===selId&&h(OrderPanel,{cust:c,menu,cats,upsertItem,settle,delCust,setBillId,setDiscount:props.setDiscount,setAdjustment:props.setAdjustment,updateCustomer:props.updateCustomer})
      );
    })
  );
}

function OrderPanel(props){
  var cust=props.cust,menu=props.menu,cats=props.cats,upsertItem=props.upsertItem;
  var settle=props.settle,delCust=props.delCust,setBillId=props.setBillId;
  var setDiscount=props.setDiscount,setAdjustment=props.setAdjustment;
  var updateCustomer=props.updateCustomer;
  var _cat=useState(cats[0]||'');var cat=_cat[0];var setCat=_cat[1];
  var _q=useState('');var q=_q[0];var setQ=_q[1];
  var _disc=useState(String(cust.discount_pct||''));var disc=_disc[0];var setDisc=_disc[1];
  var _adj=useState(String(cust.adjustment||''));var adj=_adj[0];var setAdj=_adj[1];
  var _reason=useState(cust.reason||'');var reason=_reason[0];var setReason=_reason[1];
  // Reason is needed (enabled + mandatory) whenever a discount % or a non-zero adjustment is entered.
  // Derived from live input state so it toggles instantly as the user types.
  var reasonNeeded=(Number(disc)||0)>0||(Number(adj)||0)!==0;
  // Item filter: when a search query is present, search ALL categories (global);
  // when the box is empty, show only the selected category. Each result row shows
  // its own category chip (mi-pick markup) so cross-category hits are clear.
  var qq=q.trim().toLowerCase();
  var filtered=menu.filter(function(m){
    if(m.available===false)return false;
    var matchesQ=qq?m.name.toLowerCase().indexOf(qq)!==-1:true;
    if(!matchesQ)return false;
    return qq?true:m.cat===cat;
  });
  var raw=rawTotal(cust);
  var dAmt=discountAmt(cust);
  var aAmt=adjustAmt(cust);
  var grand=finalTotal(cust);
  function printKOT(){
    if(!cust.items.length){alert('No items to send to kitchen.');return;}
    var css='*{box-sizing:border-box}body{font-family:"Courier New","Liberation Mono",Consolas,monospace;font-size:12pt;padding:3mm;max-width:74mm;margin:0 auto;-webkit-print-color-adjust:exact;print-color-adjust:exact;-webkit-text-size-adjust:none;text-size-adjust:none}h2{text-align:center;font-size:17px;margin:0 0 2px}.sub{text-align:center;font-size:11px;color:#444;margin-bottom:8px;border-bottom:1px dashed #999;padding-bottom:6px}.inf{font-size:12px;margin-bottom:2px}.it{display:flex;justify-content:space-between;font-size:15px;font-weight:bold;padding:5px 0;border-bottom:1px dotted #ccc}.q{min-width:36px;text-align:right}.tm{font-size:9px;color:#777;font-weight:normal}.foot{text-align:center;font-size:10px;color:#777;margin-top:10px}';
    var rows=cust.items.map(function(i){
      var tms=itemTimes(i);
      var tStr=tms.length?'<br/><span class="tm">'+escHtml(tms.map(timeOf).join(' · '))+'</span>':'';
      return'<div class="it"><span>'+escHtml(i.name)+tStr+'</span><span class="q">x'+(Number(i.qty)||0)+'</span></div>';
    }).join('');
    var bodyHtml='<h2>KITCHEN ORDER</h2><div class="sub">Gavthan — KOT</div><div class="inf"><b>'+escHtml(cust.name)+'</b> &nbsp; Room/Table: <b>'+escHtml(cust.room)+'</b></div><div class="inf">'+escHtml(dateOf(cust.date))+' &nbsp; '+escHtml(timeStr())+'</div><hr/>'+rows+'<div class="foot">--- Prepare above items ---</div>';
    var title='KOT_'+(cust.name||'').replace(/[^a-zA-Z0-9]/g,'');
    var fullCss='@page{size:80mm auto;margin:3mm}'+css;
    printInNewWindow(title,fullCss,bodyHtml);
  }
  return h('div',{onClick:function(e){e.stopPropagation();}},
    h('div',{className:'hr'}),
    h('div',{style:{fontSize:11,color:'#B45309',fontWeight:700,letterSpacing:0.5,marginBottom:4}},'➕ ADD ITEMS'),
    h('input',{placeholder:'Search menu…',value:q,onChange:function(e){setQ(e.target.value);},style:{marginBottom:6}}),
    h('div',{className:'cats'},cats.map(function(c){return h('button',{key:c,className:cat===c?'on':'',title:c,onClick:function(){setCat(c);},style:{fontSize:18,padding:'4px 10px',lineHeight:1}},catIcon(c));})),
    h('div',{className:'sb'},filtered.length===0?h('div',{style:{fontSize:12,color:'var(--text-2)',padding:8}},'No items.'):
      filtered.map(function(mi){
        var inO=cust.items.find(function(i){return i.id===mi.id;});
        return h('div',{key:mi.id,className:'mi-pick'+(inO?' in':''),onClick:function(){upsertItem(cust.id,mi.id,1);}},
          h(Chip,{cat:mi.cat,cats}),
          h('span',{className:'mi-name'},mi.name),
          h('span',{className:'mi-price'},'₹'+mi.price),
          inO&&h('button',{className:'qb',onClick:function(e){e.stopPropagation();upsertItem(cust.id,mi.id,-1);}},'−'),
          inO&&h('span',{className:'mi-qty'},inO.qty),
          h('button',{className:'qb',style:{background:'#B45309',color:'#fff',border:'none'},onClick:function(e){e.stopPropagation();upsertItem(cust.id,mi.id,1);}},'+')
        );
      })
    ),
    // ── Visible section divider between menu picker and current bill ──
    cust.items.length>0&&h('div',{style:{borderTop:'2px dashed #B45309',marginTop:10,marginBottom:6,paddingTop:8}}),
    cust.items.length>0&&h('div',{style:{background:'#FAEEDA',padding:'8px 10px',borderRadius:8,marginBottom:6}},
      h('div',{style:{fontSize:11,color:'#27500A',fontWeight:700,letterSpacing:0.5,marginBottom:6}},'🧾 CURRENT ORDER'),
      h('div',{className:'sb'},cust.items.map(function(it){
        var tms=itemTimes(it);
        return h('div',{key:it.id,className:'li'},
          h(Chip,{cat:it.cat,cats}),
          h('div',{style:{flex:1,minWidth:0}},
            h('div',{style:{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},it.name),
            tms.length>0&&h('div',{style:{fontSize:9,color:'var(--text-3)'}},
              tms.length<=3
                ? tms.map(timeOf).join(' · ')
                : timeOf(tms[0])+' … '+timeOf(tms[tms.length-1])+' ('+tms.length+'×)')
          ),
          h('button',{className:'qb',onClick:function(){upsertItem(cust.id,it.id,-1);}},'-'),
          h('span',{style:{minWidth:14,textAlign:'center'}},it.qty),
          h('button',{className:'qb',onClick:function(){upsertItem(cust.id,it.id,1);}},'+'),
          h('span',{style:{minWidth:44,textAlign:'right',fontWeight:700}},'₹'+(it.price*it.qty))
        );
      })),
      // Working breakdown (staff screen only)
      h('div',{style:{paddingTop:5,fontSize:12}},
        h('div',{className:'row bw'},h('span',{className:'muted'},'Items subtotal'),h('span',null,'₹'+raw)),
        dAmt>0&&h('div',{className:'row bw',style:{color:'#166534'}},
          h('span',null,'Discount ('+cust.discount_pct+'%)'),h('span',null,'-₹'+dAmt)
        ),
        cust.adjustment_on&&aAmt!==0&&h('div',{className:'row bw',style:{color:(aAmt<0?'#166534':'#991B1B')}},
          h('span',null,'Adjustment'),h('span',null,(aAmt>0?'+':'')+'₹'+aAmt)
        ),
        h('div',{className:'row bw',style:{fontWeight:700,fontSize:14,paddingTop:3,borderTop:'1px solid var(--border)',marginTop:3}},
          h('span',null,'Total'),
          h('span',{style:{color:grand===0?'#991B1B':'#B45309'}},'₹'+grand)
        )
      )
    ),
    h('div',{className:'hr'}),
    // Discount % — value-driven (no checkbox). Any value > 0 applies it.
    h('div',{className:'row',style:{marginBottom:6,gap:6}},
      h('span',{style:{fontSize:12,fontWeight:600,flex:1}},'Discount %'),
      h('input',{type:'number',value:disc,placeholder:'0',min:0,max:100,style:{width:70},
        onChange:function(e){setDisc(e.target.value);},
        onBlur:function(){setDiscount(cust.id,disc);},
        onKeyDown:function(e){if(e.key==='Enter')setDiscount(cust.id,disc);}}),
      h('span',{className:'muted',style:{fontSize:12}},'%')
    ),
    // Adjustment — value-driven (no checkbox). Any non-zero value applies it.
    h('div',{className:'row',style:{marginBottom:4,gap:6}},
      h('span',{style:{fontSize:12,fontWeight:600,flex:1}},'Adjustment'),
      h('span',{className:'muted',style:{fontSize:12}},'₹'),
      h('input',{type:'number',value:adj,placeholder:'0',style:{width:70},
        onChange:function(e){setAdj(e.target.value);},
        onBlur:function(){setAdjustment(cust.id,adj);},
        onKeyDown:function(e){if(e.key==='Enter')setAdjustment(cust.id,adj);}})
    ),
    h('div',{className:'muted',style:{fontSize:10,marginBottom:6}},'Adjustment: + amount for extra charge, - amount to deduct.'),
    // Reason field — auto-enabled & mandatory when a discount/adjustment value is entered.
    h('div',{style:{marginBottom:4}},
      h('div',{className:'row bw',style:{marginBottom:3}},
        h('span',{style:{fontSize:12,fontWeight:600,color:reasonNeeded?'#B45309':'var(--text-3)'}},
          'Reason'+(reasonNeeded?' *':'')),
        reasonNeeded&&!reason.trim()&&h('span',{style:{fontSize:10,color:'#991B1B',fontWeight:700}},'Required')
      ),
      h('input',{value:reason,disabled:!reasonNeeded,
        placeholder:reasonNeeded?'Why is discount/adjustment applied?':'Enter a discount or adjustment first',
        style:{background:reasonNeeded?'var(--surface)':'var(--surface-2)',borderColor:reasonNeeded&&!reason.trim()?'#991B1B':undefined},
        onChange:function(e){setReason(e.target.value);},
        onBlur:function(){if(updateCustomer)updateCustomer(cust.id,{reason:reason.trim()});},
        onKeyDown:function(e){if(e.key==='Enter'&&updateCustomer)updateCustomer(cust.id,{reason:reason.trim()});}})
    ),
    h('div',{className:'hr'}),
    h('div',{className:'row',style:{gap:5}},
      h('button',{className:'btn xs',onClick:function(){setBillId(cust.id);}},'🧾 Bill'),
      h('button',{className:'btn xs',onClick:printKOT},'👨‍🍳 KOT'),
      h('button',{className:'btn btn-g xs',onClick:function(){settle(cust.id);}},'✓ Settle'),
      h('button',{className:'btn btn-r xs',onClick:function(){if(confirm('Delete?'))delCust(cust.id);}},'🗑')
    )
  );
}

// ── NEW CUSTOMER TAB ───────────────────────────────
function NewTab(props){
  var addCust=props.addCust,todayCnt=props.todayCnt,allCusts=props.allCusts||[];
  var admin=props.admin;
  var _name=useState('Cust '+(todayCnt+1));var name=_name[0];var setName=_name[1];
  var _room=useState('');var room=_room[0];var setRoom=_room[1];
  var _phone=useState('');var phone=_phone[0];var setPhone=_phone[1];
  var _msg=useState('');var msg=_msg[0];var setMsg=_msg[1];
  var _search=useState('');var search=_search[0];var setSearch=_search[1];
  // Bill date — default today, allow up to 15 days back
  function ymd(d){return d.toISOString().slice(0,10);}
  var todayYMD=ymd(new Date());
  var minYMD=ymd(new Date(Date.now()-15*86400000));
  var _date=useState(todayYMD);var billDate=_date[0];var setBillDate=_date[1];
  useEffect(function(){setName('Cust '+(todayCnt+1));},[todayCnt]);

  // Deduplicate past customers by name+phone
  var pastCustomers=[];var seen={};
  allCusts.forEach(function(c){
    var k=(c.name||'').toLowerCase()+'|'+(c.phone||'');
    if(!seen[k]&&c.name&&c.name.indexOf('Cust ')!==0){seen[k]=true;pastCustomers.push(c);}
  });
  var matches=search.trim().length>=2?pastCustomers.filter(function(c){
    var q=search.toLowerCase();
    return (c.name||'').toLowerCase().indexOf(q)!==-1||(c.phone||'').indexOf(q)!==-1;
  }).slice(0,5):[];

  function pickCustomer(c){
    setName(c.name);setPhone(c.phone||'');setSearch('');
    setMsg('✓ Loaded repeat customer. Enter room number to continue.');
    setTimeout(function(){setMsg('');},3000);
  }

  function pickFromContacts(){
    if(!navigator.contacts||!navigator.contacts.select){
      alert('Contact picker not supported on this device. Use Chrome on Android for this feature, or enter the number manually.');
      return;
    }
    navigator.contacts.select(['name','tel'],{multiple:false}).then(function(cs){
      if(!cs||cs.length===0)return;
      var c=cs[0];
      var tel=c.tel&&c.tel[0]&&c.tel[0].replace(/\D/g,'');
      if(tel){setPhone(tel.slice(-10));}
      if(c.name&&c.name[0]&&(name.indexOf('Cust ')===0)){setName(c.name[0]);}
    }).catch(function(e){alert('Contact picker error: '+e.message);});
  }

  function submit(){
    if(!name.trim()||!room.trim()){setMsg('Name and room required.');return;}
    var ph=phone.trim().replace(/\D/g,'');
    if(ph && ph.length!==10){
      setMsg('Phone must be exactly 10 digits (or leave empty).');return;
    }
    // Validate the bill date is within the allowed window (admin only — staff is locked)
    if(admin&&billDate!==todayYMD){
      if(billDate<minYMD||billDate>todayYMD){
        setMsg('Bill date must be between '+minYMD+' and '+todayYMD+'.');
        setBillDate(todayYMD);return;
      }
    }
    // Build ISO date: staff always use now(); admin may backdate within window
    var dateISO;
    if(!admin||billDate===todayYMD){
      dateISO=new Date().toISOString();
    } else {
      var now=new Date();
      var parts=billDate.split('-');
      var d=new Date(Number(parts[0]),Number(parts[1])-1,Number(parts[2]),
        now.getHours(),now.getMinutes(),now.getSeconds());
      dateISO=d.toISOString();
    }
    addCust(name.trim(),room.trim(),ph,dateISO);
    setRoom('');setPhone('');setBillDate(todayYMD);setMsg('Customer added!');
    setTimeout(function(){setMsg('');},3000);
  }

  var hasContacts=!!(navigator.contacts&&navigator.contacts.select);

  return h('div',null,
    // Repeat-customer search card
    pastCustomers.length>0&&h('div',{className:'card'},
      h('div',{className:'ttl'},'Repeat Customer?'),
      h('div',{className:'muted',style:{fontSize:11,marginBottom:6}},'Search by name or phone — fills the form automatically.'),
      h('input',{placeholder:'Type name or phone (min 2 chars)…',value:search,onChange:function(e){setSearch(e.target.value);}}),
      matches.length>0&&h('div',{style:{marginTop:6,maxHeight:160,overflowY:'auto',border:'1px solid var(--border)',borderRadius:6}},
        matches.map(function(c){
          return h('div',{key:c.id,style:{padding:'6px 10px',borderBottom:'1px solid var(--surface-2)',cursor:'pointer',fontSize:12},onClick:function(){pickCustomer(c);}},
            h('div',{style:{fontWeight:700}},c.name),
            h('div',{className:'muted',style:{fontSize:10}},(c.phone||'no phone')+' · last visit '+fmtDT(c.date))
          );
        })
      ),
      search.length>=2&&matches.length===0&&h('div',{className:'muted',style:{fontSize:11,marginTop:6}},'No matches.')
    ),
    h('div',{className:'card'},
      h('div',{className:'ttl'},'New Customer'),
      h('div',{className:'muted',style:{fontSize:11,marginBottom:10}},"Today's customers: "+todayCnt),
      h('div',{style:{marginBottom:8}},
        h('div',{className:'muted',style:{fontSize:11,marginBottom:3}},'Name *'),
        h('input',{value:name,onChange:function(e){setName(e.target.value);},placeholder:'Customer name',onKeyDown:function(e){if(e.key==='Enter')submit();}})
      ),
      h('div',{style:{marginBottom:8}},
        h('div',{className:'muted',style:{fontSize:11,marginBottom:3}},'Room / Table *'),
        h('input',{value:room,onChange:function(e){setRoom(e.target.value);},placeholder:'Room 5 or Table 3',onKeyDown:function(e){if(e.key==='Enter')submit();}})
      ),
      h('div',{style:{marginBottom:8}},
        h('div',{className:'muted',style:{fontSize:11,marginBottom:3}},'Phone (optional)'),
        h('div',{className:'row',style:{gap:4}},
          h('input',{value:phone,onChange:function(e){setPhone(e.target.value);},placeholder:'10 digits',onKeyDown:function(e){if(e.key==='Enter')submit();},style:{flex:1}}),
          hasContacts&&h('button',{className:'btn xs',style:{flexShrink:0},onClick:pickFromContacts,title:'Pick from device contacts (Chrome Android only)'},'📇')
        ),
        !hasContacts&&h('div',{className:'muted',style:{fontSize:10,marginTop:2}},'Tip: Use Chrome on Android to pick from contacts.')
      ),
      h('div',{style:{marginBottom:8}},
        h('div',{className:'muted',style:{fontSize:11,marginBottom:3}},'Bill Date'),
        admin
          ? h('div',null,
              h('input',{type:'date',value:billDate,min:minYMD,max:todayYMD,
                onChange:function(e){
                  var v=e.target.value||todayYMD;
                  // Hard-clamp — browsers' native min/max are advisory; typed/pasted dates can escape them
                  if(v>todayYMD) v=todayYMD;
                  else if(v<minYMD){setMsg('Backdated bills are limited to the past 15 days.');v=minYMD;setTimeout(function(){setMsg('');},3000);}
                  setBillDate(v);
                }}),
              billDate!==todayYMD&&h('div',{style:{fontSize:10,color:'#B45309',marginTop:2,fontWeight:600}},'⚠ Backdated bill — '+billDate)
            )
          : h('div',null,
              h('input',{type:'date',value:todayYMD,disabled:true,style:{background:'var(--surface-2)'}}),
              h('div',{style:{fontSize:10,color:'var(--text-2)',marginTop:2}},'Backdated bills are admin-only.')
            )
      ),
      h('button',{className:'btn btn-a',style:{width:'100%',marginTop:4,justifyContent:'center'},onClick:submit},'Add Customer'),
      msg&&h('div',{style:{marginTop:6,fontSize:12,color:msg.indexOf('!')!==-1||msg.indexOf('✓')!==-1?'#166534':'#991B1B',textAlign:'center'}},msg)
    )
  );
}

// ── HISTORY TAB ────────────────────────────────────
function HistoryTab(props){
  var settled=props.settled,todayRev=props.todayRev,todaySett=props.todaySett;
  var cats=props.cats,setBillId=props.setBillId,delCust=props.delCust;
  var admin=props.admin,userEmail=props.userEmail,users=props.users||[];

  if(!admin){
    var todayStr2=new Date().toDateString();
    var mine=settled.filter(function(c){return c.added_by===userEmail&&c.settled_at&&new Date(c.settled_at).toDateString()===todayStr2;})
      .sort(function(a,b){return new Date(b.settled_at)-new Date(a.settled_at);});
    var myRev=mine.reduce(function(s,c){return s+finalTotal(c);},0);
    return h('div',null,
      h('div',{className:'metrics'},
        h('div',{className:'met'},h('div',{className:'ml'},'My Revenue Today'),h('div',{className:'mv'},'₹'+myRev)),
        h('div',{className:'met'},h('div',{className:'ml'},'My Bills Today'),h('div',{className:'mv'},mine.length)),
        h('div',{className:'met'},h('div',{className:'ml'},'Date'),h('div',{style:{fontSize:12,fontWeight:700,marginTop:2}},todayStr()))
      ),
      h('div',{className:'card'},
        h('div',{className:'ttl'},"Today's Orders — Mine"),
        h('div',{className:'muted',style:{fontSize:11,marginBottom:8}},'Your settled orders from today only.'),
        mine.length===0?h('div',{className:'empty'},'No settled orders yet today.'):
        mine.map(function(c){
          var t=finalTotal(c);
          return h('div',{key:c.id,className:'li',style:{flexDirection:'column',alignItems:'stretch',gap:3,paddingBottom:6}},
            h('div',{className:'row bw'},
              h('span',{style:{fontWeight:700}},c.name+' · '+c.room),
              h('div',{className:'row',style:{gap:4}},h('span',{style:{fontWeight:700,color:'#B45309'}},'₹'+t),
                h('button',{className:'btn xs',onClick:function(){setBillId(c.id);}},'🧾 Bill'))
            ),
            h('div',{className:'row',style:{gap:5}},h('span',{className:'muted',style:{fontSize:10}},fmtDT(billDateTime(c))),h('span',{className:'tag-s'},'Settled'),c.bill_no&&h('span',{style:{fontSize:10,fontWeight:700,color:'#B45309'}},fmtBill(c.bill_no))),
            h('div',{style:{fontSize:11,color:'var(--text-2)'}},c.items.slice(0,3).map(function(i){return i.name+'×'+i.qty;}).join(', ')+(c.items.length>3?', …':'')),
            (c.discount_on||c.adjustment_on)&&c.reason&&h('div',{style:{fontSize:11,color:'#B45309',fontStyle:'italic'}},'Reason: '+c.reason)
          );
        })
      )
    );
  }

  var now=new Date();
  var _mode=useState('date');var filterMode=_mode[0];var setFilterMode=_mode[1];
  var _sn=useState('');var searchName=_sn[0];var setSearchName=_sn[1];
  var _sf=useState('');var dateFrom=_sf[0];var setDateFrom=_sf[1];
  var _st=useState('');var dateTo=_st[0];var setDateTo=_st[1];
  var _sm=useState(String(now.getMonth()+1).padStart(2,'0'));var selMonth=_sm[0];var setSelMonth=_sm[1];
  var _sy=useState(String(now.getFullYear()));var selYear=_sy[0];var setSelYear=_sy[1];
  var _ss=useState('all');var selStaff=_ss[0];var setSelStaff=_ss[1];
  var _page=useState(0);var page=_page[0];var setPage=_page[1];
  var PAGE_SIZE=10;
  var allRev=settled.reduce(function(s,c){return s+finalTotal(c);},0);
  var staffList=users.filter(function(u){return u.active!==false;});
  var shown=settled.filter(function(c){
    if(selStaff!=='all'&&(c.added_by||'')!==selStaff)return false;
    if(searchName){var n=searchName.toLowerCase();if(c.name.toLowerCase().indexOf(n)===-1&&c.room.toLowerCase().indexOf(n)===-1)return false;}
    // Bucket by settled_at (the canonical bill date) so History ties out exactly
    // to the Manager dashboard, which uses settled_at||date. Fall back to date
    // for legacy bills with no settled_at.
    var dt=c.settled_at?new Date(c.settled_at):(c.date?new Date(c.date):null);
    if(!dt)return true;
    if(filterMode==='date'){if(dateFrom&&dt<new Date(dateFrom))return false;if(dateTo&&dt>new Date(dateTo+'T23:59:59'))return false;}
    else if(filterMode==='month'){if(String(dt.getMonth()+1).padStart(2,'0')!==selMonth)return false;if(String(dt.getFullYear())!==selYear)return false;}
    else if(filterMode==='year'){if(String(dt.getFullYear())!==selYear)return false;}
    return true;
  }).sort(function(a,b){return new Date(b.settled_at||b.date)-new Date(a.settled_at||a.date);});
  var shownRev=shown.reduce(function(s,c){return s+finalTotal(c);},0);
  var totalPages=Math.max(1,Math.ceil(shown.length/PAGE_SIZE));
  var safePage=Math.min(page,totalPages-1);
  var pageItems=shown.slice(safePage*PAGE_SIZE,(safePage+1)*PAGE_SIZE);
  // Reset to page 0 when filters change
  useEffect(function(){setPage(0);},[searchName,dateFrom,dateTo,selMonth,selYear,selStaff,filterMode]);

  function exportCSV(){
    if(typeof XLSX==='undefined'){alert('Excel library not loaded. Check your internet connection and reload.');return;}
    // ── 1) Build filter-parameters block (top-left of the sheet) ──
    var modeLabel='All time';
    if(filterMode==='month') modeLabel='Month: '+monthNames[Number(selMonth)-1]+' '+selYear;
    else if(filterMode==='year') modeLabel='Year: '+selYear;
    else if(dateFrom||dateTo) modeLabel='Date range: '+(dateFrom||'…')+' to '+(dateTo||'…');
    var staffLabel=(selStaff==='all')?'All staff':selStaff;
    var nameFilter=searchName||'(none)';
    var generatedAt=new Date().toLocaleString('en-IN');

    var aoa=[]; // array of arrays, becomes the sheet
    aoa.push(['Gavthan — Sales Report']);
    aoa.push([]);
    aoa.push(['Generated:', generatedAt]);
    aoa.push(['Filter — period:', modeLabel]);
    aoa.push(['Filter — staff:', staffLabel]);
    aoa.push(['Filter — customer/room search:', nameFilter]);
    aoa.push(['Bills in report:', shown.length]);
    aoa.push(['Revenue total:', shownRev]);
    aoa.push([]); // spacer
    var headerRowIdx=aoa.length;
    aoa.push(['Bill No','Settled At','Customer','Room/Table','Phone','Item','Qty','Rate','Item Amt','Bill Subtotal','Discount %','Discount Amt','Adjustment','Reason','Bill Total','Staff']);

    // ── 2) Body rows: one row per ITEM (so qty/rate are real cells) ──
    var grandQty=0, grandAmt=0;
    shown.forEach(function(c){
      var sub=rawTotal(c), dA=discountAmt(c), aA=adjustAmt(c), tot=finalTotal(c);
      var items=(c.items||[]);
      if(items.length===0){
        // Bill with no items still appears once
        aoa.push([
          c.bill_no?fmtBill(c.bill_no):'', c.settled_at||c.date||'', c.name||'', c.room||'', c.phone||'',
          '(no items)','','','', sub,
          c.discount_on?(Number(c.discount_pct)||0):'', dA||'',
          c.adjustment_on?aA:'', (c.discount_on||c.adjustment_on)?(c.reason||''):'',
          tot, c.added_by||''
        ]);
      } else {
        items.forEach(function(it,idx){
          var q=Number(it.qty)||0, r=Number(it.price)||0, amt=q*r;
          grandQty+=q; grandAmt+=amt;
          aoa.push([
            idx===0?(c.bill_no?fmtBill(c.bill_no):''):'',
            idx===0?(c.settled_at||c.date||''):'',
            idx===0?(c.name||''):'',
            idx===0?(c.room||''):'',
            idx===0?(c.phone||''):'',
            it.name||'', q, r, amt,
            idx===0?sub:'',
            idx===0?(c.discount_on?(Number(c.discount_pct)||0):''):'',
            idx===0?(dA||''):'',
            idx===0?(c.adjustment_on?aA:''):'',
            idx===0?((c.discount_on||c.adjustment_on)?(c.reason||''):''):'',
            idx===0?tot:'',
            idx===0?(c.added_by||''):''
          ]);
        });
      }
    });

    // ── 3) Totals row at the bottom ──
    aoa.push([]);
    aoa.push(['TOTAL','','','','','', grandQty,'', grandAmt,'','','','','', shownRev,'']);

    // ── 4) Build worksheet with styles + column widths ──
    var ws=XLSX.utils.aoa_to_sheet(aoa);
    // Column widths
    ws['!cols']=[
      {wch:11},{wch:18},{wch:18},{wch:10},{wch:13},{wch:24},{wch:6},{wch:8},{wch:10},
      {wch:11},{wch:10},{wch:11},{wch:11},{wch:22},{wch:10},{wch:24}
    ];
    // Merge title cell across the header columns
    if(!ws['!merges']) ws['!merges']=[];
    ws['!merges'].push({s:{r:0,c:0},e:{r:0,c:15}}); // title row spans all cols

    // ── 5) Workbook ──
    var wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws,'Sales Report');

    var fname='gavthan-sales-'+new Date().toISOString().slice(0,10)+'.xlsx';
    XLSX.writeFile(wb,fname);
  }
  var months=['01','02','03','04','05','06','07','08','09','10','11','12'];
  var monthNames=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var years=[];for(var y=now.getFullYear();y>=now.getFullYear()-4;y--)years.push(String(y));
  var hasFilter=searchName||dateFrom||dateTo||selStaff!=='all'||(filterMode==='month')||(filterMode==='year');

  return h('div',null,
    h('div',{className:'metrics'},
      h('div',{className:'met'},h('div',{className:'ml'},"Today's Rev"),h('div',{className:'mv'},'₹'+todayRev)),
      h('div',{className:'met'},h('div',{className:'ml'},'Bills Today'),h('div',{className:'mv'},todaySett.length)),
      h('div',{className:'met'},h('div',{className:'ml'},'Total Rev'),h('div',{className:'mv'},'₹'+allRev))
    ),
    // Daily closing summary — per-staff breakdown for end-of-day reconciliation
    h('div',{className:'card'},
      h('div',{className:'ttl'},"Today's Closing Summary"),
      h('div',{className:'muted',style:{fontSize:11,marginBottom:8}},new Date().toLocaleDateString('en-IN',{weekday:'long',day:'2-digit',month:'short',year:'numeric'})),
      todaySett.length===0
        ? h('div',{className:'muted',style:{fontSize:12}},'No bills settled today yet.')
        : h('div',null,
            (function(){
              var byStaff={};
              todaySett.forEach(function(c){
                var k=c.added_by||'unknown';
                if(!byStaff[k])byStaff[k]={count:0,rev:0};
                byStaff[k].count++;byStaff[k].rev+=finalTotal(c);
              });
              return Object.keys(byStaff).map(function(k){
                var su=(props.users||[]).find(function(u){return u.email===k;});
                var nm=su?(su.display_name||k.split('@')[0]):k;
                return h('div',{key:k,className:'row bw',style:{fontSize:12,padding:'4px 0',borderBottom:'1px dotted var(--border)'}},
                  h('span',null,nm+' — '+byStaff[k].count+' bill'+(byStaff[k].count!==1?'s':'')),
                  h('span',{style:{fontWeight:700,color:'#B45309'}},'₹'+byStaff[k].rev)
                );
              });
            })(),
            h('div',{className:'row bw',style:{fontSize:14,fontWeight:700,paddingTop:6,marginTop:2,borderTop:'2px solid #333'}},
              h('span',null,'TOTAL — '+todaySett.length+' bill'+(todaySett.length!==1?'s':'')),
              h('span',{style:{color:'#B45309'}},'₹'+todayRev)
            )
          )
    ),
    h('div',{className:'card'},
      h('div',{className:'row bw',style:{marginBottom:10,flexWrap:'wrap',gap:6}},
        h('div',{className:'ttl',style:{margin:0}},'Billing History'),
        h('div',{className:'row',style:{gap:4}},
          shown.length>0&&h('button',{className:'btn xs btn-g',onClick:exportCSV,title:'Download filtered orders as Excel (.xlsx)'},'⬇ Export Excel'),
          hasFilter&&h('button',{className:'btn xs btn-r',onClick:function(){setSearchName('');setDateFrom('');setDateTo('');setSelStaff('all');setFilterMode('date');}},'✕ Clear')
        )
      ),
      h('div',{className:'cats',style:{marginBottom:8}},['date','month','year'].map(function(m){
        return h('button',{key:m,className:filterMode===m?'on':'',onClick:function(){setFilterMode(m);}},{date:'By Date',month:'By Month',year:'By Year'}[m]);
      })),
      filterMode==='date'&&h('div',{className:'search-row'},
        h('input',{type:'date',value:dateFrom,onChange:function(e){setDateFrom(e.target.value);},style:{flex:1}}),
        h('span',{className:'muted',style:{flexShrink:0,fontSize:11}},'to'),
        h('input',{type:'date',value:dateTo,onChange:function(e){setDateTo(e.target.value);},style:{flex:1}})
      ),
      filterMode==='month'&&h('div',{className:'search-row'},
        h('select',{value:selMonth,onChange:function(e){setSelMonth(e.target.value);},style:{flex:1}},
          months.map(function(m,i){return h('option',{key:m,value:m},monthNames[i]);})),
        h('select',{value:selYear,onChange:function(e){setSelYear(e.target.value);},style:{flex:1}},
          years.map(function(y){return h('option',{key:y,value:y},y);}))
      ),
      filterMode==='year'&&h('div',{className:'search-row'},
        h('select',{value:selYear,onChange:function(e){setSelYear(e.target.value);},style:{flex:2}},
          years.map(function(y){return h('option',{key:y,value:y},y);}))
      ),
      h('div',{className:'search-row',style:{marginTop:6}},
        h('input',{placeholder:'Search customer / room…',value:searchName,onChange:function(e){setSearchName(e.target.value);},style:{flex:2}}),
        staffList.length>0&&h('select',{value:selStaff,onChange:function(e){setSelStaff(e.target.value);},style:{flex:1,minWidth:0}},
          h('option',{value:'all'},'All Staff'),
          staffList.map(function(u){return h('option',{key:u.id,value:u.email},initCap(u.display_name||u.email.split('@')[0]));})
        )
      ),
      h('div',{className:'row bw',style:{fontSize:11,color:'var(--text-2)',margin:'6px 0 8px'}},
        h('span',null,shown.length+' record'+(shown.length!==1?'s':'')+(hasFilter?' (filtered)':'')+(shown.length>PAGE_SIZE?' — page '+(safePage+1)+'/'+totalPages:'')),
        shown.length>0&&h('span',{style:{fontWeight:700,color:'#B45309'}},'Total: ₹'+shownRev)
      ),
      shown.length===0?h('div',{className:'empty'},'No records found.'):
      pageItems.map(function(c){
        var t=finalTotal(c);
        var su=staffList.find(function(u){return u.email===c.added_by;});
        var sn=initCap(su?(su.display_name||su.email.split('@')[0]):(c.added_by||''));
        return h('div',{key:c.id,className:'li',style:{flexDirection:'column',alignItems:'stretch',gap:3,paddingBottom:6}},
          h('div',{className:'row bw'},
            h('span',{style:{fontWeight:700}},c.name+' · '+c.room),
            h('div',{className:'row',style:{gap:4}},
              h('span',{style:{fontWeight:700,color:'#B45309'}},'₹'+t),
              h('button',{className:'btn xs',onClick:function(){setBillId(c.id);}},'🧾 Bill'),
              h('button',{className:'btn btn-r xs',onClick:function(){delCust(c.id);}},'🗑')
            )
          ),
          h('div',{className:'row',style:{gap:5,flexWrap:'wrap'}},
            c.settled_at&&h('span',{className:'muted',style:{fontSize:10}},fmtDT(billDateTime(c))),c.bill_no&&h('span',{style:{fontSize:10,fontWeight:700,color:'#B45309'}},fmtBill(c.bill_no)),
            h('span',{className:'tag-s'},'Settled'),
            sn&&h('span',{style:{fontSize:10,color:'var(--text-2)'}},'by '+sn)
          ),
          h('div',{style:{fontSize:11,color:'var(--text-2)'}},c.items.slice(0,3).map(function(i){return i.name+'×'+i.qty;}).join(', ')+(c.items.length>3?', …':'')),
          (c.discount_on||c.adjustment_on)&&c.reason&&h('div',{style:{fontSize:11,color:'#B45309',fontStyle:'italic'}},'Reason: '+c.reason)
        );
      }),
      // Pagination controls
      shown.length>PAGE_SIZE&&h('div',{className:'row bw',style:{marginTop:10,paddingTop:8,borderTop:'1px solid var(--border)'}},
        h('button',{className:'btn xs',onClick:function(){setPage(Math.max(0,safePage-1));},disabled:safePage===0,style:{opacity:safePage===0?0.4:1}},'← Prev'),
        h('div',{style:{display:'flex',gap:3,flexWrap:'wrap',justifyContent:'center'}},
          (function(){
            var btns=[];
            var maxBtns=Math.min(7,totalPages);
            var start=Math.max(0,Math.min(safePage-3,totalPages-maxBtns));
            for(var p=start;p<start+maxBtns;p++){
              (function(pp){
                btns.push(h('button',{key:pp,className:'btn xs'+(pp===safePage?' btn-a':''),style:{minWidth:28,padding:'4px 6px'},onClick:function(){setPage(pp);}},pp+1));
              })(p);
            }
            return btns;
          })()
        ),
        h('button',{className:'btn xs',onClick:function(){setPage(Math.min(totalPages-1,safePage+1));},disabled:safePage>=totalPages-1,style:{opacity:safePage>=totalPages-1?0.4:1}},'Next →')
      )
    )
  );
}

// ── MENU TAB ───────────────────────────────────────
function MenuTab(props){
  var cats=props.cats,saveCats=props.saveCats,menu=props.menu;
  var addMenuItem=props.addMenuItem,updateMenuItem=props.updateMenuItem,deleteMenuItem=props.deleteMenuItem;
  var toggleMenuAvail=props.toggleMenuAvail;
  var reorderItems=props.reorderItems;
  var _sel=useState(cats[0]||'');var selCat=_sel[0];var setSelCat=_sel[1];
  var _nc=useState('');var newCat=_nc[0];var setNewCat=_nc[1];
  var _eci=useState(null);var editCatId=_eci[0];var setEditCatId=_eci[1];
  var _ecv=useState('');var editCatVal=_ecv[0];var setEditCatVal=_ecv[1];
  var _nn=useState('');var newN=_nn[0];var setNewN=_nn[1];
  var _np=useState('');var newP=_np[0];var setNewP=_np[1];
  var _ei=useState(null);var editId=_ei[0];var setEditId=_ei[1];
  var _en=useState('');var editN=_en[0];var setEditN=_en[1];
  var _ep=useState('');var editP=_ep[0];var setEditP=_ep[1];
  var catListRef=useRef(null);
  var itemListRef=useRef(null);

  function doAddCat(){var n=newCat.trim();if(!n)return;if(cats.indexOf(n)!==-1){alert('Already exists.');return;}saveCats(cats.concat([n]),null,null);setSelCat(n);setNewCat('');}
  function doSaveCat(){var n=editCatVal.trim();if(!n){alert('Name required.');return;}saveCats(cats.map(function(c){return c===editCatId?n:c;}),editCatId,n);if(selCat===editCatId)setSelCat(n);setEditCatId(null);}
  function doDelCat(cat){if(!confirm('Delete "'+cat+'"?'))return;saveCats(cats.filter(function(c){return c!==cat;}),cat,null);var rem=cats.filter(function(c){return c!==cat;});setSelCat(rem[0]||'');if(editCatId===cat)setEditCatId(null);}
  function doAddItem(){var n=newN.trim();var p=parseInt(newP);if(!n){alert('Name required.');return;}if(isNaN(p)||p<0){alert('Valid price required.');return;}addMenuItem(selCat,n,p);setNewN('');setNewP('');}
  function doSaveItem(){var n=editN.trim();var p=parseInt(editP);if(!n||isNaN(p)||p<0){alert('Valid name and price.');return;}updateMenuItem(editId,n,p);setEditId(null);}
  var selItems=menu.filter(function(m){return m.cat===selCat;});

  // ── Drag-and-drop wiring (SortableJS — works on mobile touch out of the box) ──
  // handle:'.dh' restricts drag activation to the ⋮⋮ grip. filter+preventOnFilter:false ensures
  // taps on inputs/buttons inside rows pass through to React (otherwise Sortable swallows them).
  useEffect(function(){
    if(typeof Sortable==='undefined'||!catListRef.current)return;
    var s=Sortable.create(catListRef.current,{
      animation:150,
      handle:'.dh',
      draggable:'[data-cat]',
      filter:'button, input, .editrow',
      preventOnFilter:false,
      ghostClass:'sort-ghost',
      onEnd:function(evt){
        if(evt.oldIndex===evt.newIndex)return;
        var nodes=Array.prototype.slice.call(catListRef.current.querySelectorAll('[data-cat]'));
        var newOrder=nodes.map(function(n){return n.getAttribute('data-cat');});
        // Defensive: keep only cats that actually exist (filter renamed/deleted from stale DOM)
        var valid=newOrder.filter(function(c){return cats.indexOf(c)!==-1;});
        if(valid.length===cats.length) saveCats(valid,null,null);
      }
    });
    return function(){try{s.destroy();}catch(e){}};
  },[cats.join('|')]);

  useEffect(function(){
    if(typeof Sortable==='undefined'||!itemListRef.current||!reorderItems)return;
    var s=Sortable.create(itemListRef.current,{
      animation:150,
      handle:'.dh',
      draggable:'[data-itemid]',
      filter:'button, input, .editrow',
      preventOnFilter:false,
      ghostClass:'sort-ghost',
      onEnd:function(evt){
        if(evt.oldIndex===evt.newIndex)return;
        var nodes=Array.prototype.slice.call(itemListRef.current.querySelectorAll('[data-itemid]'));
        var ids=nodes.map(function(n){return n.getAttribute('data-itemid');});
        if(ids.length) reorderItems(ids);
      }
    });
    return function(){try{s.destroy();}catch(e){}};
  },[selCat,selItems.map(function(i){return i.id;}).join('|')]);

  return h('div',null,
    h('div',{className:'card'},
      h('div',{className:'ttl'},'Categories'),
      h('div',{className:'muted',style:{fontSize:11,marginBottom:8}},'Drag the ⋮⋮ handle to reorder.'),
      h('div',{className:'addbx',style:{marginBottom:10}},
        h('div',{className:'addbx-lbl'},'Add Category'),
        h('div',{className:'row'},
          h('input',{placeholder:'Category name…',value:newCat,onChange:function(e){setNewCat(e.target.value);},onKeyDown:function(e){if(e.key==='Enter')doAddCat();}}),
          h('button',{className:'btn btn-a xs',style:{flexShrink:0},onClick:doAddCat},'+ Add')
        )
      ),
      h('div',{ref:catListRef},cats.map(function(cat){
        var cnt=menu.filter(function(m){return m.cat===cat;}).length;
        if(editCatId===cat)return h('div',{key:cat,'data-cat':cat,style:{marginBottom:6}},h('div',{className:'editrow row'},
          h('input',{value:editCatVal,onChange:function(e){setEditCatVal(e.target.value);},autoFocus:true,style:{flex:1,fontSize:12},onKeyDown:function(e){if(e.key==='Enter')doSaveCat();if(e.key==='Escape')setEditCatId(null);}}),
          h('button',{className:'btn btn-a xs',onClick:doSaveCat},'✓ Save'),
          h('button',{className:'btn xs',onClick:function(){setEditCatId(null);}},'Cancel')
        ));
        return h('div',{key:cat,'data-cat':cat,style:{marginBottom:6}},
          h('div',{className:'row bw',style:{background:cat===selCat?'var(--surface-2)':'var(--surface)',border:'1px solid var(--border)',borderRadius:8,padding:'7px 10px',cursor:'pointer'},onClick:function(){setSelCat(cat);}},
            h('div',{className:'row',style:{gap:6,flex:1,minWidth:0}},
              h('span',{className:'dh',title:'Drag to reorder',onClick:function(e){e.stopPropagation();},style:{cursor:'grab',touchAction:'none',userSelect:'none',color:'var(--text-3)',padding:'0 4px',fontSize:14,fontWeight:700}},'⋮⋮'),
              h(Chip,{cat,cats}),
              h('span',{style:{fontWeight:cat===selCat?700:400,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},cat),
              h('span',{className:'muted',style:{fontSize:11}},cnt+' item'+(cnt!==1?'s':''))
            ),
            h('div',{className:'row',style:{gap:4}},
              h('button',{className:'btn xs',onClick:function(e){e.stopPropagation();setEditCatId(cat);setEditCatVal(cat);}},'✏ Rename'),
              h('button',{className:'btn btn-r xs',onClick:function(e){e.stopPropagation();doDelCat(cat);}},'🗑 Delete')
            )
          )
        );
      }))
    ),
    selCat&&h('div',{className:'card'},
      h('div',{className:'row bw',style:{marginBottom:10}},h('div',{className:'ttl',style:{margin:0}},'Items in:'),h(Chip,{cat:selCat,cats})),
      selItems.length===0&&h('div',{className:'muted',style:{fontSize:12,marginBottom:8}},'No items. Add below.'),
      selItems.length>0&&h('div',{className:'muted',style:{fontSize:11,marginBottom:8}},'Drag the ⋮⋮ handle to reorder.'),
      h('div',{ref:itemListRef,className:'sb',style:{marginBottom:8}},
        selItems.map(function(it){
          if(editId===it.id)return h('div',{key:it.id,'data-itemid':it.id,className:'editrow',style:{marginBottom:4}},
            h('div',{className:'muted',style:{fontSize:11,marginBottom:6}},'Editing: ',h('strong',null,it.name)),
            h('div',{className:'row',style:{marginBottom:6}},
              h('input',{value:editN,onChange:function(e){setEditN(e.target.value);},style:{flex:2},autoFocus:true,onKeyDown:function(e){if(e.key==='Enter')doSaveItem();}}),
              h('input',{value:editP,type:'number',min:0,onChange:function(e){setEditP(e.target.value);},style:{flex:1,maxWidth:72}})
            ),
            h('div',{className:'row',style:{gap:4}},h('button',{className:'btn btn-a xs',onClick:doSaveItem},'✓ Save'),h('button',{className:'btn xs',onClick:function(){setEditId(null);}},'Cancel'))
          );
          var avail=it.available!==false;
          return h('div',{key:it.id,'data-itemid':it.id,className:'li',style:{opacity:avail?1:0.55}},
            h('span',{className:'dh',title:'Drag to reorder',style:{cursor:'grab',touchAction:'none',userSelect:'none',color:'var(--text-3)',padding:'0 4px',fontSize:14,fontWeight:700,flexShrink:0}},'⋮⋮'),
            h('span',{style:{flex:1,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},it.name,!avail&&h('span',{style:{fontSize:10,color:'#991B1B',fontWeight:700,marginLeft:5}},'OUT OF STOCK')),
            h('span',{style:{fontWeight:700,color:'#B45309',minWidth:40,textAlign:'right'}},'₹'+it.price),
            h('button',{className:'btn xs '+(avail?'btn-r':'btn-g'),style:{marginLeft:8},onClick:function(){toggleMenuAvail(it.id,!avail);}},avail?'Mark Out':'Mark In'),
            h('button',{className:'btn xs',onClick:function(){setEditId(it.id);setEditN(it.name);setEditP(''+it.price);}},'✏ Edit'),
            h('button',{className:'btn btn-r xs',onClick:function(){deleteMenuItem(it.id);}},'🗑 Del')
          );
        })
      ),
      h('div',{className:'addbx'},
        h('div',{className:'addbx-lbl'},'Add Item to '+selCat),
        h('div',{className:'row',style:{marginBottom:6}},
          h('input',{placeholder:'Item name',value:newN,onChange:function(e){setNewN(e.target.value);},onKeyDown:function(e){if(e.key==='Enter')doAddItem();},style:{flex:2}}),
          h('input',{placeholder:'₹',type:'number',min:0,value:newP,onChange:function(e){setNewP(e.target.value);},onKeyDown:function(e){if(e.key==='Enter')doAddItem();},style:{flex:1,maxWidth:80}})
        ),
        h('button',{className:'btn btn-a xs',style:{width:'100%',justifyContent:'center'},onClick:doAddItem},'+ Add Item')
      )
    )
  );
}

// ── CUSTOMERS TAB (Admin) ──────────────────────────
function CustomersTab(props){
  var custs=props.custs||[];
  var _q=useState('');var q=_q[0];var setQ=_q[1];

  // Group customers by phone (or name+room if no phone)
  var map={};
  custs.forEach(function(c){
    if(!c.name||c.name.indexOf('Cust ')===0)return; // skip auto-generated default names
    var key=(c.phone&&c.phone.length>=10)?c.phone:(c.name+'|'+(c.room||''));
    var spent=c.status==='settled'?finalTotal(c):0;
    if(!map[key]){
      map[key]={name:c.name,phone:c.phone||'',visits:0,settled:0,totalSpent:0,lastVisit:c.date};
    }
    var r=map[key];
    r.visits++;
    if(c.status==='settled'){r.settled++;r.totalSpent+=spent;}
    if(new Date(c.date)>new Date(r.lastVisit)) r.lastVisit=c.date;
  });
  var rows=Object.keys(map).map(function(k){return map[k];})
    .sort(function(a,b){return new Date(b.lastVisit)-new Date(a.lastVisit);});

  var filtered=q.trim()?rows.filter(function(r){
    var s=q.toLowerCase();
    return r.name.toLowerCase().indexOf(s)!==-1||(r.phone||'').indexOf(s)!==-1;
  }):rows;

  var totalRev=rows.reduce(function(s,r){return s+r.totalSpent;},0);

  return h('div',null,
    h('div',{className:'metrics'},
      h('div',{className:'met'},h('div',{className:'ml'},'Unique'),h('div',{className:'mv'},rows.length)),
      h('div',{className:'met'},h('div',{className:'ml'},'Bills'),h('div',{className:'mv'},rows.reduce(function(s,r){return s+r.settled;},0))),
      h('div',{className:'met'},h('div',{className:'ml'},'Revenue'),h('div',{className:'mv'},'₹'+totalRev))
    ),
    h('div',{className:'card'},
      h('div',{className:'ttl'},'Customers'),
      h('div',{className:'muted',style:{fontSize:11,marginBottom:8}},'Unique customers identified by phone number (or name+room if no phone).'),
      h('input',{placeholder:'Search by name or phone…',value:q,onChange:function(e){setQ(e.target.value);},style:{marginBottom:8}}),
      filtered.length===0?h('div',{className:'empty'},rows.length===0?'No customers yet.':'No matches.'):
      filtered.map(function(r,i){
        return h('div',{key:i,className:'li',style:{flexDirection:'column',alignItems:'stretch',gap:4,paddingBottom:8}},
          h('div',{className:'row bw'},
            h('span',{style:{fontWeight:700,fontSize:13}},r.name),
            h('span',{style:{fontWeight:700,color:'#B45309'}},'₹'+r.totalSpent)
          ),
          h('div',{className:'row',style:{gap:6,flexWrap:'wrap',fontSize:11,color:'var(--text-2)'}},
            r.phone&&h('span',null,'📞 '+r.phone),
            h('span',null,'🗓 '+r.visits+' visit'+(r.visits!==1?'s':'')+' ('+r.settled+' settled)'),
            h('span',null,'Last: '+fmtDT(r.lastVisit))
          )
        );
      })
    )
  );
}

// ── USERS TAB ──────────────────────────────────────
function UsersTab(props){
  // Defense-in-depth: refuse to render if the caller isn't a seeded super-admin
  if(!props.superAdmin||!isAdminEmail(props.currentEmail)){
    return h('div',{className:'card'},
      h('div',{className:'ttl'},'Access Denied'),
      h('div',{className:'muted',style:{fontSize:12}},'The Users tab is restricted to the seeded admin(s) listed in GH_ADMINS.')
    );
  }
  var users=props.users,currentUid=props.currentUid,addUser=props.addUser;
  var toggleUserActive=props.toggleUserActive,changeUserRole=props.changeUserRole;
  var sendReset=props.sendReset,deleteUser=props.deleteUser;
  var sessionTimeout=props.sessionTimeout,saveSessionTimeout=props.saveSessionTimeout;
  var upiId=props.upiId||'',saveUpiId=props.saveUpiId;
  var backupDatabase=props.backupDatabase;
  var restoreFromBackup=props.restoreFromBackup;
  var driveInterval=props.driveInterval||'off',saveDriveInterval=props.saveDriveInterval,driveLast=props.driveLast;
  var _restoreMsg=useState('');var restoreMsg=_restoreMsg[0];var setRestoreMsg=_restoreMsg[1];
  var _driveMsg=useState('');var driveMsg=_driveMsg[0];var setDriveMsg=_driveMsg[1];
  var _driveFiles=useState(null);var driveFiles=_driveFiles[0];var setDriveFiles=_driveFiles[1];
  var _driveAuth=useState(!!Drive.getToken());var driveAuth=_driveAuth[0];var setDriveAuth=_driveAuth[1];
  // Check the server-side connection status on mount (a refresh token may exist even on a new device)
  useEffect(function(){
    if(!Drive.configured())return;
    Drive.checkStatus().then(function(connected){if(connected)setDriveAuth(true);});
  },[]);
  function doRestoreFile(e){
    var f=e.target.files&&e.target.files[0];if(!f)return;
    if(!confirm('Restoring will OVERWRITE current data with the backup file contents. Continue?')){e.target.value='';return;}
    var rd=new FileReader();
    rd.onload=function(){
      try{
        var dump=JSON.parse(rd.result);
        setRestoreMsg('Restoring…');
        restoreFromBackup(dump,setRestoreMsg).then(function(){setRestoreMsg('✓ Restore complete.');}).catch(function(er){setRestoreMsg('Error: '+er.message);});
      }catch(er){setRestoreMsg('Invalid JSON file: '+er.message);}
    };
    rd.readAsText(f);e.target.value='';
  }
  function driveConnect(){
    setDriveMsg('Connecting to Google Drive…');
    Drive.authorize().then(function(){setDriveAuth(true);setDriveMsg('✓ Connected to Drive.');}).catch(function(e){setDriveMsg('Error: '+e.message);});
  }
  function driveDisconnect(){
    if(!confirm('Disconnect Google Drive? This removes the stored refresh token from the server — all devices will need to reconnect.'))return;
    setDriveMsg('Disconnecting…');
    Drive.disconnect().then(function(){setDriveAuth(false);setDriveFiles(null);setDriveMsg('Disconnected.');});
  }
  function driveBackupNow(){
    setDriveMsg('Backing up to Drive…');
    backupDatabase(true).then(function(d){return Drive.upload(d);}).then(function(){
      setDriveMsg('✓ Uploaded to Google Drive.');setDriveFiles(null);
    }).catch(function(e){setDriveMsg('Error: '+e.message);});
  }
  function driveListBackups(){
    setDriveMsg('Loading backup list…');
    Drive.list().then(function(fs){setDriveFiles(fs);setDriveMsg(fs.length+' backup'+(fs.length!==1?'s':'')+' found.');}).catch(function(e){setDriveMsg('Error: '+e.message);});
  }
  function driveRestore(file){
    if(!confirm('Restore from "'+file.name+'"?\nThis OVERWRITES current data.'))return;
    setDriveMsg('Downloading and restoring…');
    Drive.download(file.id).then(function(dump){return restoreFromBackup(dump,setDriveMsg);}).then(function(){setDriveMsg('✓ Restored from '+file.name);}).catch(function(e){setDriveMsg('Error: '+e.message);});
  }
  function driveDeleteFile(file){
    if(!confirm('Permanently delete "'+file.name+'" from Google Drive?\nThis cannot be undone.'))return;
    setDriveMsg('Deleting…');
    Drive.deleteFile(file.id).then(function(){setDriveMsg('✓ Deleted '+file.name);driveListBackups();}).catch(function(e){setDriveMsg('Error: '+e.message);});
  }
  function driveDeleteAll(){
    if(!confirm('DELETE ALL Drive backups? This permanently removes every backup file. Cannot be undone.'))return;
    if(!confirm('Are you absolutely sure? Click OK to delete all backups.'))return;
    setDriveMsg('Deleting all backups…');
    Drive.deleteAll().then(function(r){setDriveMsg('✓ Deleted '+r.deleted+' of '+(r.total||r.deleted)+' backups.');driveListBackups();}).catch(function(e){setDriveMsg('Error: '+e.message);});
  }
  var _to=useState(String(sessionTimeout||30));var toVal=_to[0];var setToVal=_to[1];
  var _upiV=useState(upiId);var upiVal=_upiV[0];var setUpiVal=_upiV[1];
  var _upiMsg=useState('');var upiMsg=_upiMsg[0];var setUpiMsg=_upiMsg[1];
  useEffect(function(){setUpiVal(upiId);},[upiId]);
  // Thermal printer settings
  var _thermSettings=useState(ThermalPrinter.settings());var thermSettings=_thermSettings[0];var setThermSettingsState=_thermSettings[1];
  function saveThermSettings(s){ThermalPrinter.saveSettings(s);setThermSettingsState(s);}
  useEffect(function(){setToVal(String(sessionTimeout||30));},[sessionTimeout]);
  var _ne=useState('');var newEmail=_ne[0];var setNewEmail=_ne[1];
  var _np=useState('');var newPass=_np[0];var setNewPass=_np[1];
  var _nn=useState('');var newName=_nn[0];var setNewName=_nn[1];
  var _msg=useState('');var msg=_msg[0];var setMsg=_msg[1];
  var _busy=useState(false);var busy=_busy[0];var setBusy=_busy[1];
  function doAdd(){
    if(!newEmail.trim()||!newPass||!newName.trim()){setMsg('All fields required.');return;}
    if(newPass.length<6){setMsg('Password min 6 chars.');return;}
    setBusy(true);setMsg('');
    addUser(newEmail.trim(),newPass,newName.trim(),function(err,ok){
      setBusy(false);
      if(err){setMsg('Error: '+err);}else{setMsg(ok||'Done!');setNewEmail('');setNewPass('');setNewName('');}
    });
  }
  function isOnline(u){
    if(!u.last_seen_at) return false;
    return (Date.now()-new Date(u.last_seen_at).getTime()) < 2*60*1000; // active if last seen within 2 min
  }
  var activeCount=users.filter(isOnline).length;
  return h('div',null,
    h('div',{className:'card'},
      h('div',{className:'ttl'},'Session Settings'),
      h('div',{className:'muted',style:{fontSize:11,marginBottom:8}},'Auto-logout users after this many minutes of inactivity.'),
      h('div',{className:'row',style:{gap:6}},
        h('span',{style:{fontSize:12}},'Timeout:'),
        h('input',{type:'number',min:1,max:480,value:toVal,style:{width:80},
          onChange:function(e){setToVal(e.target.value);}}),
        h('span',{style:{fontSize:12}},'minutes'),
        h('button',{className:'btn btn-a xs',onClick:function(){saveSessionTimeout(toVal);}},'Save')
      ),
      h('div',{className:'muted',style:{fontSize:10,marginTop:4}},'Currently: '+(sessionTimeout||30)+' min. Applies to all users.')
    ),
    // UPI Payment card — the VPA printed on new bills (leave blank to hide the UPI block)
    h('div',{className:'card'},
      h('div',{className:'ttl'},'UPI Payment'),
      h('div',{className:'muted',style:{fontSize:11,marginBottom:8}},'UPI ID (VPA) shown on bills for instant payment. Leave blank to hide the UPI block on all bills.'),
      h('div',{className:'row',style:{gap:6}},
        h('input',{type:'text',value:upiVal,placeholder:'name@bank',style:{flex:1},
          onChange:function(e){setUpiVal(e.target.value);}}),
        h('button',{className:'btn btn-a xs',onClick:function(){
          var v=(upiVal||'').trim();
          if(v&&v.indexOf('@')===-1){setUpiMsg('Invalid UPI ID — must look like name@bank.');setTimeout(function(){setUpiMsg('');},3000);return;}
          if(saveUpiId)saveUpiId(v);
          setUpiMsg(v?'✓ UPI ID saved.':'✓ UPI block disabled.');setTimeout(function(){setUpiMsg('');},3000);
        }},'Save')
      ),
      h('div',{className:'muted',style:{fontSize:10,marginTop:4}},upiId?('Currently: '+upiId):'No UPI ID set — the UPI block is hidden on bills.'),
      upiMsg&&h('div',{style:{marginTop:6,fontSize:12,color:upiMsg.indexOf('✓')!==-1?'#166534':'#991B1B'}},upiMsg)
    ),
    // Thermal Printer Settings card
    h('div',{className:'card'},
      h('div',{className:'ttl'},'Thermal Printer (ESC/POS)'),
      h('div',{className:'muted',style:{fontSize:11,marginBottom:8}},'Configure how the 🧾 Thermal button delivers bills to the printer. Bluetooth works on Chrome/Edge (Android, Desktop). For iOS/Safari, use the WebSocket relay.'),
      h('div',{className:'row',style:{gap:8,marginBottom:6,flexWrap:'wrap'}},
        h('label',{className:'row',style:{gap:4,cursor:'pointer',fontSize:12}},
          h('input',{type:'radio',name:'thtr',checked:(thermSettings.transport||'bt')==='bt',style:{width:'auto'},
            onChange:function(){saveThermSettings(Object.assign({},thermSettings,{transport:'bt'}));}}),
          h('span',null,'Bluetooth')),
        h('label',{className:'row',style:{gap:4,cursor:'pointer',fontSize:12}},
          h('input',{type:'radio',name:'thtr',checked:thermSettings.transport==='ws',style:{width:'auto'},
            onChange:function(){saveThermSettings(Object.assign({},thermSettings,{transport:'ws'}));}}),
          h('span',null,'WebSocket relay (iOS)'))
      ),
      thermSettings.transport==='ws'&&h('div',{style:{marginBottom:6}},
        h('div',{className:'muted',style:{fontSize:10,marginBottom:3}},'Relay URL (e.g. ws://192.168.1.10:8088)'),
        h('input',{value:thermSettings.wsUrl||'',placeholder:'ws://lan-ip:8088',
          onChange:function(e){saveThermSettings(Object.assign({},thermSettings,{wsUrl:e.target.value}));}})
      ),
      h('div',{className:'muted',style:{fontSize:10,whiteSpace:'pre-line'}},
        ThermalPrinter.isBTSupported()
          ? '✓ Web Bluetooth available on this device.\nIf you get "globally disabled" error: open chrome://flags, search "Web Bluetooth", enable it, then relaunch Chrome — OR switch to WebSocket relay.'
          : '⚠ Web Bluetooth NOT available on this browser (iOS Safari / disabled Chrome).\nUse the WebSocket relay option — runs a tiny helper on any LAN device.'
      )
    ),
    // Backup & Restore card
    h('div',{className:'card'},
      h('div',{className:'ttl'},'Backup & Restore'),
      h('div',{className:'muted',style:{fontSize:11,marginBottom:8}},'Manual JSON backup of menu, customers, orders, users, config.'),
      h('div',{className:'row',style:{gap:6,flexWrap:'wrap'}},
        h('button',{className:'btn btn-a xs',onClick:function(){backupDatabase().catch(function(e){setRestoreMsg('Error: '+e.message);});}},'⬇ Download Backup'),
        h('label',{className:'btn btn-r xs',style:{cursor:'pointer'}},'⬆ Restore from File',
          h('input',{type:'file',accept:'.json,application/json',style:{display:'none'},onChange:doRestoreFile}))
      ),
      restoreMsg&&h('div',{style:{marginTop:6,fontSize:11,color:restoreMsg.indexOf('✓')===0?'#166534':(restoreMsg.indexOf('Error')!==-1?'#991B1B':'var(--text-2)'),whiteSpace:'pre-wrap'}},restoreMsg),
      h('div',{className:'muted',style:{fontSize:10,marginTop:6}},'Restore handles missing categories by auto-creating them. Item references in past orders are snapshots so they survive menu changes.')
    ),
    // Google Drive sync card
    h('div',{className:'card'},
      h('div',{className:'ttl'},'Google Drive Auto-Backup'),
      !Drive.configured()
        ? h('div',{className:'muted',style:{fontSize:11}},
            h('div',{style:{marginBottom:6}},'⚙ Not configured. To enable:'),
            h('ol',{style:{paddingLeft:18,margin:0,fontSize:11}},
              h('li',null,'Create OAuth Client ID at Google Cloud Console (Web application type)'),
              h('li',null,'Add your app URL (e.g. https://you.github.io/...) to Authorized JavaScript origins'),
              h('li',null,'Enable Google Drive API for the project'),
              h('li',null,'Paste the Client ID into ',h('code',null,'window.GH_CONFIG.googleClientId'),' in the HTML')
            )
          )
        : h('div',null,
            h('div',{className:'row bw',style:{marginBottom:8}},
              h('span',{style:{fontSize:12,fontWeight:600,color:driveAuth?'#166534':'#991B1B'}},
                driveAuth?'● Connected':'○ Not connected'),
              driveAuth
                ? h('button',{className:'btn xs',onClick:driveDisconnect},'Disconnect')
                : h('button',{className:'btn btn-a xs',onClick:driveConnect},'Connect to Drive')
            ),
            driveAuth&&h('div',null,
              h('div',{className:'row',style:{gap:6,marginBottom:8,flexWrap:'wrap'}},
                h('span',{style:{fontSize:12}},'Auto-backup:'),
                h('select',{value:driveInterval,onChange:function(e){saveDriveInterval(e.target.value);},style:{padding:'4px 6px',fontSize:12}},
                  ['off','daily','weekly','monthly'].map(function(o){return h('option',{key:o,value:o},o.charAt(0).toUpperCase()+o.slice(1));})
                ),
                h('button',{className:'btn btn-g xs',onClick:driveBackupNow},'⬆ Backup Now'),
                h('button',{className:'btn xs',onClick:driveListBackups},'📂 List Backups'),
                h('button',{className:'btn xs btn-r',onClick:driveDeleteAll,title:'Delete every backup from Drive'},'🗑 Delete All')
              ),
              driveLast&&h('div',{className:'muted',style:{fontSize:10,marginBottom:6}},'Last auto-backup: '+fmtDT(driveLast)),
              driveFiles&&h('div',{style:{maxHeight:200,overflowY:'auto',border:'1px solid var(--border)',borderRadius:6,padding:4}},
                driveFiles.length===0
                  ? h('div',{className:'muted',style:{fontSize:11,padding:6}},'No backups in Drive yet.')
                  : driveFiles.map(function(f){
                      return h('div',{key:f.id,className:'row bw',style:{padding:'5px 6px',fontSize:11,borderBottom:'1px dotted var(--border)'}},
                        h('div',{style:{flex:1,minWidth:0}},
                          h('div',{style:{fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},f.name),
                          h('div',{className:'muted',style:{fontSize:10}},fmtDT(f.createdTime)+(f.size?' · '+Math.round(f.size/1024)+' KB':''))
                        ),
                        h('div',{className:'row',style:{gap:4}},
                          h('button',{className:'btn xs',onClick:function(){driveRestore(f);}},'Restore'),
                          h('button',{className:'btn xs btn-r',onClick:function(){driveDeleteFile(f);}},'Delete')
                        )
                      );
                    })
              )
            ),
            driveMsg&&h('div',{style:{marginTop:6,fontSize:11,color:driveMsg.indexOf('✓')!==-1?'#166534':(driveMsg.indexOf('Error')!==-1?'#991B1B':'var(--text-2)'),whiteSpace:'pre-wrap'}},driveMsg)
          )
    ),
    h('div',{className:'card'},
      h('div',{className:'row bw',style:{marginBottom:10}},
        h('div',{className:'ttl',style:{margin:0}},'User Management'),
        h('span',{style:{fontSize:11,color:'#166534',fontWeight:700}},
          h('span',{style:{display:'inline-block',width:8,height:8,borderRadius:'50%',background:'#22c55e',marginRight:4,boxShadow:'0 0 4px #22c55e'}}),
          activeCount+' online'
        )
      ),
      h('div',{className:'muted',style:{fontSize:11,marginBottom:10}},users.length+' registered user'+(users.length!==1?'s':'')+' · "Online" = active in last 2 minutes'),
      users.length===0&&h('div',{className:'muted',style:{fontSize:12,padding:'8px 0'}},'No users yet.'),
      users.map(function(u){
        var isSelf=u.id===currentUid;
        var online=isOnline(u);
        return h('div',{key:u.id,className:'usr-card'},
          h('div',{style:{flex:1,minWidth:0}},
            h('div',{className:'row',style:{gap:5}},
              online&&h('span',{title:'Active now',style:{display:'inline-block',width:7,height:7,borderRadius:'50%',background:'#22c55e',boxShadow:'0 0 4px #22c55e',flexShrink:0}}),
              h('span',{style:{fontWeight:700,fontSize:13}},u.display_name||u.email)
            ),
            h('div',{className:'muted',style:{fontSize:11}},u.email),
            u.last_seen_at&&!online&&h('div',{className:'muted',style:{fontSize:10}},'Last seen: '+fmtDT(u.last_seen_at))
          ),
          h('span',{className:u.role==='admin'?'badge-admin':'badge-user'},u.role||'user'),
          !u.active&&h('span',{className:'badge-off'},'Disabled'),
          !isSelf&&h('div',{className:'row',style:{gap:4,flexWrap:'wrap'}},
            h('button',{className:'btn xs btn-y',onClick:function(){sendReset(u.email);},'title':'Send reset email'},'📧 Reset Pwd'),
            h('button',{className:'btn xs',onClick:function(){changeUserRole(u.id,u.role==='admin'?'user':'admin');}},u.role==='admin'?'→ Staff':'→ Admin'),
            h('button',{className:'btn xs '+(u.active?'btn-r':'btn-g'),onClick:function(){toggleUserActive(u.id,u.active);}},u.active?'Disable':'Enable'),
            deleteUser&&h('button',{className:'btn xs btn-r',onClick:function(){deleteUser(u.id,u.email);},title:'Delete user'},'🗑 Delete')
          ),
          isSelf&&h('span',{className:'muted',style:{fontSize:11}},'(you)')
        );
      })
    ),
    h('div',{className:'card'},
      h('div',{className:'ttl'},'Add New Staff'),
      h('div',{className:'msg-ok',style:{fontSize:11,marginBottom:10,padding:'7px 10px'}},'✓ Admin session is protected — adding user will not sign you out.'),
      [['Name','Full name',newName,setNewName,'text'],['Email','staff@hotel.com',newEmail,setNewEmail,'email'],['Temp Password','Min 6 characters',newPass,setNewPass,'password']].map(function(f){
        return h('div',{key:f[0],style:{marginBottom:8}},
          h('div',{className:'muted',style:{fontSize:11,marginBottom:3}},f[0]),
          h('input',{value:f[2],onChange:function(e){f[3](e.target.value);},placeholder:f[1],type:f[4],onKeyDown:function(e){if(e.key==='Enter')doAdd();}})
        );
      }),
      msg&&h('div',{className:msg.toLowerCase().indexOf('error')!==-1?'msg-err':'msg-ok',style:{marginBottom:8}},msg),
      h('button',{className:'btn btn-a',style:{width:'100%',justifyContent:'center'},onClick:doAdd,disabled:busy},busy&&h('span',{className:'spin'}),'Add Staff User'),
      h('div',{className:'muted',style:{fontSize:11,marginTop:8}},'Share temp password with staff. Use Reset Pwd to send them email to set their own.')
    )
  );
}

// ── MANAGER TAB (admin-only analytics dashboard) ───
// Pure read-only view computed from settled bills (mh_customers, status==='settled').
// finalTotal()/rawTotal() are the same helpers the rest of the app bills with, so
// every figure here ties out exactly to History/receipts.
function inr(n){return '₹'+Math.round(n||0).toLocaleString('en-IN');}
function ManagerTab(props){
  var custs=props.custs||[],users=props.users||[];
  var _per=useState('30d');var per=_per[0];var setPer=_per[1];

  var settled=custs.filter(function(c){return c.status==='settled';});
  function billDate(c){return new Date(c.settled_at||c.date);}
  var now=new Date();
  var todayKey=now.toDateString();

  // ── KPIs (fixed windows) ──
  var today=settled.filter(function(c){return billDate(c).toDateString()===todayKey;});
  var todayRev=today.reduce(function(s,c){return s+finalTotal(c);},0);
  var todayAvg=today.length?Math.round(todayRev/today.length):0;
  var month=settled.filter(function(c){var d=billDate(c);return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();});
  var monthRev=month.reduce(function(s,c){return s+finalTotal(c);},0);

  // ── Gauge: today vs your best-ever day ──
  var byDay={};settled.forEach(function(c){var k=billDate(c).toDateString();byDay[k]=(byDay[k]||0)+finalTotal(c);});
  var dayVals=Object.keys(byDay).map(function(k){return byDay[k];});
  var bestDay=Math.max.apply(null,[1].concat(dayVals));
  var gaugePct=Math.min(1,bestDay?todayRev/bestDay:0);
  var R=42,C=2*Math.PI*R,ARC=C*0.75;            // 270° dial, gap at the bottom
  var off=ARC*(1-gaugePct);

  // ── Last 7 days ──
  var days=[];
  for(var i=6;i>=0;i--){var d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()-i);days.push({d:d,key:d.toDateString(),rev:0,bills:0});}
  settled.forEach(function(c){var k=billDate(c).toDateString();var slot=null;for(var j=0;j<days.length;j++)if(days[j].key===k){slot=days[j];break;}if(slot){slot.rev+=finalTotal(c);slot.bills++;}});
  var maxDay=Math.max.apply(null,[1].concat(days.map(function(x){return x.rev;})));
  var peakIdx=0;days.forEach(function(x,idx){if(x.rev>days[peakIdx].rev)peakIdx=idx;});
  var DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  // ── Period-filtered breakdowns ──
  function inPeriod(c){
    if(per==='all')return true;
    var d=billDate(c);
    if(per==='today')return d.toDateString()===todayKey;
    var diff=(now-d)/86400000;
    return per==='7d'?diff<7:diff<30;
  }
  var pbills=settled.filter(inPeriod);
  var perRev=pbills.reduce(function(s,c){return s+finalTotal(c);},0);

  // Top items by quantity
  var itemMap={};
  pbills.forEach(function(c){(c.items||[]).forEach(function(it){
    var m=itemMap[it.name]||(itemMap[it.name]={name:it.name,qty:0,rev:0,cat:it.cat});
    m.qty+=it.qty;m.rev+=it.price*it.qty;
  });});
  var topItems=Object.keys(itemMap).map(function(k){return itemMap[k];}).sort(function(a,b){return b.qty-a.qty;}).slice(0,6);
  var maxItemQty=Math.max.apply(null,[1].concat(topItems.map(function(x){return x.qty;})));

  // Sales by staff
  function staffName(email){var u=users.filter(function(x){return x.email===email;})[0];return (u&&u.display_name)?u.display_name:initCap((email||'—').split('@')[0]);}
  var staffMap={};
  pbills.forEach(function(c){var k=c.added_by||'—';var m=staffMap[k]||(staffMap[k]={email:k,rev:0,bills:0});m.rev+=finalTotal(c);m.bills++;});
  var topStaff=Object.keys(staffMap).map(function(k){return staffMap[k];}).sort(function(a,b){return b.rev-a.rev;}).slice(0,6);
  var maxStaffRev=Math.max.apply(null,[1].concat(topStaff.map(function(x){return x.rev;})));

  // Sales by category
  var catMap={};
  pbills.forEach(function(c){(c.items||[]).forEach(function(it){var k=it.cat||'Other';catMap[k]=(catMap[k]||0)+it.price*it.qty;});});
  var topCats=Object.keys(catMap).map(function(k){return{cat:k,rev:catMap[k]};}).sort(function(a,b){return b.rev-a.rev;}).slice(0,8);
  var maxCatRev=Math.max.apply(null,[1].concat(topCats.map(function(x){return x.rev;})));

  // Busiest hours (by bill count)
  var hours=[];for(var hh=0;hh<24;hh++)hours.push(0);
  pbills.forEach(function(c){hours[billDate(c).getHours()]++;});
  var maxHour=Math.max.apply(null,[1].concat(hours));

  var perLabel={today:'Today','7d':'Last 7 days','30d':'Last 30 days',all:'All time'}[per];

  if(settled.length===0)
    return h('div',{className:'empty'},'📊 No settled bills yet. Once you settle some orders, your sales analytics will appear here.');

  return h('div',{className:'dash'},
    // ── Hero gauge ──
    h('div',{className:'gauge-card'},
      h('div',{className:'gauge-wrap'},
        h('svg',{className:'gauge-svg',viewBox:'0 0 100 100'},
          h('defs',null,h('linearGradient',{id:'gaugeGrad',x1:'0',y1:'0',x2:'1',y2:'1'},
            h('stop',{offset:'0%',stopColor:'#f59e0b'}),
            h('stop',{offset:'100%',stopColor:'#b45309'}))),
          h('circle',{className:'gauge-arc-bg',cx:50,cy:50,r:R,strokeWidth:9,strokeDasharray:ARC+' '+C}),
          h('circle',{className:'gauge-arc-fg',cx:50,cy:50,r:R,strokeWidth:9,strokeDasharray:ARC+' '+C,strokeDashoffset:off})
        ),
        h('div',{className:'gauge-center'},
          h('div',{className:'gauge-cap'},"Today's Sales"),
          h('div',{className:'gauge-val'},inr(todayRev)),
          h('div',{className:'gauge-sub'},today.length+' bill'+(today.length===1?'':'s')+' · '+Math.round(gaugePct*100)+'% of best day')
        )
      )
    ),
    // ── KPI cards ──
    h('div',{className:'kpis'},
      h('div',{className:'kpi'},h('div',{className:'kpi-l'},'📈 This Month'),h('div',{className:'kpi-v'},inr(monthRev)),h('div',{className:'kpi-sub'},month.length+' bills')),
      h('div',{className:'kpi'},h('div',{className:'kpi-l'},'🧾 Avg Bill (today)'),h('div',{className:'kpi-v'},inr(todayAvg))),
      h('div',{className:'kpi'},h('div',{className:'kpi-l'},'🏆 Best Day'),h('div',{className:'kpi-v'},inr(bestDay))),
      h('div',{className:'kpi'},h('div',{className:'kpi-l'},'∑ All-time'),h('div',{className:'kpi-v'},inr(settled.reduce(function(s,c){return s+finalTotal(c);},0))),h('div',{className:'kpi-sub'},settled.length+' bills'))
    ),
    // ── 7-day bar chart ──
    h('div',{className:'panel'},
      h('div',{className:'panel-h'},h('span',null,'Revenue · last 7 days'),h('span',{className:'muted'},inr(days.reduce(function(s,x){return s+x.rev;},0)))),
      h('div',{className:'bars'},days.map(function(x,idx){
        return h('div',{key:x.key,className:'bar-col'+(idx===peakIdx&&x.rev>0?' peak':'')},
          h('div',{className:'bar-v'},x.rev?('₹'+(x.rev>=1000?(Math.round(x.rev/100)/10)+'k':Math.round(x.rev))):''),
          h('div',{className:'bar-track'},h('div',{className:'bar-fill',style:{height:(x.rev/maxDay*100)+'%'}})),
          h('div',{className:'bar-x'},DOW[x.d.getDay()])
        );
      }))
    ),
    // ── Period selector (drives the breakdown panels below) ──
    h('div',{className:'cats',style:{marginBottom:0,marginTop:2}},
      [['today','Today'],['7d','7 days'],['30d','30 days'],['all','All time']].map(function(p){
        return h('button',{key:p[0],className:per===p[0]?'on':'',onClick:function(){setPer(p[0]);}},p[1]);
      })
    ),
    // ── Top items ──
    h('div',{className:'panel'},
      h('div',{className:'panel-h'},h('span',null,'Top items'),h('span',{className:'muted'},perLabel)),
      topItems.length?h('div',{className:'rank'},topItems.map(function(it,idx){
        return h('div',{key:it.name,className:'rank-row'},
          h('div',{className:'rank-rank'},idx+1),
          h('div',{className:'rank-main'},
            h('div',{className:'rank-name'},it.name),
            h('div',{className:'rank-bar'},h('div',{className:'rank-bar-fill',style:{width:(it.qty/maxItemQty*100)+'%'}}))
          ),
          h('div',{className:'rank-val'},it.qty,h('small',null,' sold'))
        );
      })):h('div',{className:'empty'},'No sales in this period.')
    ),
    // ── Sales by staff ──
    h('div',{className:'panel'},
      h('div',{className:'panel-h'},h('span',null,'Sales by staff'),h('span',{className:'muted'},inr(perRev))),
      topStaff.length?h('div',{className:'rank'},topStaff.map(function(st,idx){
        return h('div',{key:st.email,className:'rank-row'},
          h('div',{className:'rank-rank'},idx+1),
          h('div',{className:'rank-main'},
            h('div',{className:'rank-name'},staffName(st.email),h('span',{className:'muted',style:{fontWeight:600}},'· '+st.bills)),
            h('div',{className:'rank-bar'},h('div',{className:'rank-bar-fill',style:{width:(st.rev/maxStaffRev*100)+'%'}}))
          ),
          h('div',{className:'rank-val'},inr(st.rev))
        );
      })):h('div',{className:'empty'},'No sales in this period.')
    ),
    // ── Sales by category ──
    h('div',{className:'panel'},
      h('div',{className:'panel-h'},h('span',null,'Sales by category'),h('span',{className:'muted'},perLabel)),
      topCats.length?h('div',{className:'rank'},topCats.map(function(ct,idx){
        return h('div',{key:ct.cat,className:'rank-row'},
          h('div',{className:'rank-main'},
            h('div',{className:'rank-name'},catIcon(ct.cat),' ',ct.cat),
            h('div',{className:'rank-bar'},h('div',{className:'rank-bar-fill',style:{width:(ct.rev/maxCatRev*100)+'%'}}))
          ),
          h('div',{className:'rank-val'},inr(ct.rev))
        );
      })):h('div',{className:'empty'},'No sales in this period.')
    ),
    // ── Busiest hours ──
    h('div',{className:'panel'},
      h('div',{className:'panel-h'},h('span',null,'Busiest hours'),h('span',{className:'muted'},'by bills · '+perLabel)),
      h('div',{className:'heat'},hours.map(function(v,hr){
        var op=v?(0.18+0.82*(v/maxHour)):0.12;
        return h('div',{key:hr,className:'heat-cell',title:hr+':00 — '+v+' bills',
          style:{background:'rgba(180,83,9,'+op.toFixed(2)+')'}});
      })),
      h('div',{className:'row bw',style:{marginTop:2}},['12a','6a','12p','6p','11p'].map(function(l,idx){
        return h('div',{key:idx,className:'heat-x',style:{flex:'none'}},l);
      }))
    ),
    h('div',{style:{height:4}})
  );
}

// ── BILL MODAL ─────────────────────────────────────
function BillModal(props){
  var cust=props.cust,onClose=props.onClose,onSavePhone=props.onSavePhone;
  var updateCustomer=props.updateCustomer;
  var previewBillNo=props.previewBillNo;
  // UPI ID from live config (falls back to the build-time constant for older callers)
  var upiId=props.upiId!=null?props.upiId:UPI_ID;
  // Displayed bill number = locked one if settled, else current preview (lastBillNo+1)
  // STRICT: settled bills lock to their stored bill_no immutably; preview only used for unsettled
  var displayBillNo=(cust.status==='settled')?(cust.bill_no||null):(cust.bill_no||previewBillNo||null);
  var t=finalTotal(cust);
  var _editN=useState(cust.name||'');var editName=_editN[0];var setEditName=_editN[1];
  var _editP=useState(cust.phone||'');var editPhone=_editP[0];var setEditPhone=_editP[1];
  var _edited=useState(false);var edited=_edited[0];var setEdited=_edited[1];
  var billRef=React.useRef(null);

  function saveEdits(){
    var nm=editName.trim();
    var ph=editPhone.trim().replace(/\D/g,'');
    if(!nm){alert('Customer name cannot be empty.');return;}
    if(ph&&ph.length!==10){alert('Phone must be 10 digits (or empty).');return;}
    if(updateCustomer) updateCustomer(cust.id,{name:nm,phone:ph});
    setEdited(false);
    alert('Customer details updated.');
  }

  function pad(s,n){s=String(s);while(s.length<n)s+=' ';return s;}
  function padL(s,n){s=String(s);while(s.length<n)s=' '+s;return s;}

  function billText(){
    var lines=[];
    // Header
    lines.push('*GAVTHAN*');
    lines.push('_Receipt / Bill'+(displayBillNo?' '+fmtBill(displayBillNo):'')+'_');
    lines.push('');
    lines.push('Customer: *'+cust.name+'*');
    lines.push('Room/Table: *'+cust.room+'*');
    var billTs=billDateTime(cust)||cust.date;
    lines.push('Date: '+dateOf(billTs)+'   Time: '+timeOf(billTs));
    if(cust.phone) lines.push('Phone: '+cust.phone);
    lines.push('');
    // Monospace table — WhatsApp renders triple-backtick blocks in fixed-width font
    lines.push('```');
    lines.push('Item             Qty  Rate    Amt');
    lines.push('----------------------------------');
    cust.items.forEach(function(i){
      var nm=i.name.length>16?i.name.substring(0,15)+'.':i.name;
      lines.push(pad(nm,17)+padL(i.qty,3)+'  '+padL('Rs'+i.price,6)+'  '+padL('Rs'+(i.price*i.qty),6));
    });
    lines.push('----------------------------------');
    var dA=discountAmt(cust),aA=adjustAmt(cust);
    if(dA>0||cust.adjustment_on&&aA!==0){
      lines.push(pad('Subtotal',24)+padL('Rs'+rawTotal(cust),8));
      if(dA>0) lines.push(pad('Discount ('+cust.discount_pct+'%)',24)+padL('-Rs'+dA,8));
      if(cust.adjustment_on&&aA!==0) lines.push(pad('Adjustment',24)+padL((aA>0?'+':'')+'Rs'+aA,8));
    }
    lines.push(pad('TOTAL',24)+padL('Rs'+t,8));
    lines.push('```');
    if((cust.discount_on||cust.adjustment_on)&&cust.reason){
      lines.push('Reason: '+cust.reason);
    }
    // UPI payment link (UPI VPA must NOT be URL-encoded; @ is literal)
    if(upiId){
      var amt=Math.round(Number(t)); // integer rupees, no decimals
      // Standard NPCI UPI deep link spec — pa unencoded, pn/tn encoded
      var upiLink='upi://pay?pa='+upiId
        +'&pn='+encodeURIComponent(HOTEL_NAME)
        +'&am='+amt
        +'&cu=INR'
        +'&tn='+encodeURIComponent(HOTEL_NAME+' bill');
      lines.push('');
      lines.push('💳 *PAY ₹'+amt+' INSTANTLY*');
      lines.push('Tap the link below — your UPI app opens with ₹'+amt+' pre-filled:');
      lines.push(upiLink);
    }
    lines.push('');
    lines.push('_Thank you for visiting Gavthan!_');
    return lines.join('\n');
  }

  // Ask for phone if not already saved (or invalid), and persist it to customer DB
  function ensurePhone(cb){
    var ph=(cust.phone||'').replace(/\D/g,'');
    if(ph.length===10){cb(ph);return;}
    var input=prompt('Enter customer 10-digit mobile number\n(will be saved to customer record):',cust.phone||'');
    if(input===null)return;
    var clean=input.replace(/\D/g,'');
    if(clean.length!==10){alert('Phone must be exactly 10 digits.');return;}
    if(onSavePhone) onSavePhone(clean);
    cb(clean);
  }

  function sendWhatsApp(){
    if(t===0){alert('Cannot send a zero-amount bill. Add items first.');return;}
    ensurePhone(function(phone){
      // wa.me with phone → opens WhatsApp with that contact pre-selected
      // (Web Share API with image looked nicer but didn't pre-fill recipient)
      var waPhone=phone.length===10?'91'+phone:phone;
      var url='https://wa.me/'+waPhone+'?text='+encodeURIComponent(billText());
      window.open(url,'_blank');
    });
  }

  function sendSMS(){
    if(t===0){alert('Cannot send a zero-amount bill. Add items first.');return;}
    ensurePhone(function(phone){
      var url='sms:+91'+phone+'?body='+encodeURIComponent(billText());
      window.location.href=url;
    });
  }
  function printBill(){
    if(t===0){alert('Cannot print a zero-amount bill. Add items first.');return;}
    var bill=buildBillHTML();
    var title=(cust.name||'Bill').replace(/[^a-zA-Z0-9]/g,'')+'_'+t;
    // Strip @page/@media print from the embedded css — we re-apply @page at the top of fullCss.
    var cleanCss=bill.css
      .replace(/@page\s*\{[^}]*\}/g,'')
      .replace(/@media\s+print\s*\{[^}]*\}/g,'');
    var fullCss='@page{size:80mm auto;margin:3mm}'+cleanCss;
    printInNewWindow(title,fullCss,bill.body);
  }
  // Builds the receipt HTML used by both Print and JPEG export (identical layout)
  function buildBillHTML(){
    var css='*{box-sizing:border-box}body{font-family:"Courier New",monospace;font-size:12px;padding:14px;max-width:320px;margin:0 auto}h2{text-align:center;font-size:18px;letter-spacing:3px;margin-bottom:2px}.sub{text-align:center;font-size:11px;color:#666;margin-bottom:12px;border-bottom:1px dashed #ccc;padding-bottom:8px}.inf{display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px}hr{border:1px dashed #bbb;margin:7px 0}table{width:100%;border-collapse:collapse;font-size:12px}th{padding:3px 0;border-bottom:1px solid #999;text-align:left;font-weight:bold}th:not(:first-child),td:not(:first-child){text-align:right}td{padding:3px 0;border-bottom:1px dotted #eee}.sl{display:flex;justify-content:space-between;font-size:11px;margin:2px 0}.tot{display:flex;justify-content:space-between;font-size:15px;font-weight:bold;padding-top:8px;border-top:2px solid #333;margin-top:6px}.foot{text-align:center;font-size:11px;color:#666;margin-top:14px;border-top:1px dashed #ccc;padding-top:8px}';
    var rows=cust.items.map(function(i){return'<tr><td>'+escHtml(i.name)+'</td><td>'+(Number(i.qty)||0)+'</td><td>&#8377;'+(Number(i.price)||0)+'</td><td>&#8377;'+((Number(i.price)||0)*(Number(i.qty)||0))+'</td></tr>';}).join('');
    var dA=discountAmt(cust),aA=adjustAmt(cust);
    var breakdown='';
    if(dA>0||cust.adjustment_on&&aA!==0){
      breakdown+='<div class="sl"><span>Subtotal</span><span>&#8377;'+rawTotal(cust)+'</span></div>';
      if(dA>0) breakdown+='<div class="sl"><span>Discount ('+(Number(cust.discount_pct)||0)+'%)</span><span>-&#8377;'+dA+'</span></div>';
      if(cust.adjustment_on&&aA!==0) breakdown+='<div class="sl"><span>Adjustment</span><span>'+(aA>0?'+':'')+'&#8377;'+aA+'</span></div>';
      if(cust.reason) breakdown+='<div class="sl" style="color:#666;font-style:italic"><span>Reason:</span><span>'+escHtml(cust.reason)+'</span></div>';
    }
    // Date/time shown on the bill = the immutable official Bill Date & Time (see billDateTime)
    var billTs=billDateTime(cust)||cust.date;
    var body='<h2>GAVTHAN</h2><div class="sub">Receipt / Bill'+(displayBillNo?' '+fmtBill(displayBillNo):'')+'</div><div class="inf"><span><b>'+escHtml(cust.name)+'</b></span><span>'+escHtml(dateOf(billTs))+'</span></div><div class="inf"><span>Room/Table: <b>'+escHtml(cust.room)+'</b></span><span>'+escHtml(timeOf(billTs))+'</span></div>'+(cust.phone?'<div class="inf"><span>Ph: '+escHtml(cust.phone)+'</span></div>':'')+'<hr><table><thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amt</th></tr></thead><tbody>'+rows+'</tbody></table><hr>'+breakdown+'<div class="tot"><span>TOTAL</span><span>&#8377;'+t+'</span></div>'+(upiId?'<hr><div style="text-align:center;font-size:11px;margin-top:6px"><b>Pay via UPI</b><br/>'+escHtml(upiId)+'<br/>Amount: &#8377;'+t+'</div>':'')+'<div class="foot">Thank you for visiting Gavthan!<br>Please come again.</div>';
    return {css:css,body:body};
  }

  function saveJPEG(){
    if(t===0){alert('Cannot save a zero-amount bill. Add items first.');return;}
    if(typeof html2canvas==='undefined'){alert('Image library not loaded. Check your internet connection and reload.');return;}
    renderBillCanvas(function(canvas){
      var fname=(cust.name||'Bill').replace(/[^a-zA-Z0-9]/g,'')+'_'+t+'.jpg';
      canvas.toBlob(function(blob){
        if(!blob){alert('Could not generate image.');return;}
        var url=URL.createObjectURL(blob);
        var a=document.createElement('a');
        a.href=url;a.download=fname;
        document.body.appendChild(a);a.click();document.body.removeChild(a);
        setTimeout(function(){URL.revokeObjectURL(url);},1000);
      },'image/jpeg',0.9);
    },function(e){alert('Image export failed: '+e.message);});
  }
  function savePDF(){
    if(t===0){alert('Cannot save a zero-amount bill. Add items first.');return;}
    if(typeof html2canvas==='undefined'){alert('Image library not loaded. Check your internet connection and reload.');return;}
    if(typeof jsPDF==='undefined'){alert('PDF library not loaded. Check your internet connection and reload.');return;}
    renderBillCanvas(function(canvas){
      try{
        // Page width fixed at 80mm (thermal receipt width); height scales to content so the
        // whole bill lands on ONE page with no clipping. mm units, portrait.
        var pageWmm=80;
        var pageHmm=pageWmm*(canvas.height/canvas.width);
        var pdf=new jsPDF({orientation:'portrait',unit:'mm',format:[pageWmm,pageHmm]});
        var img=canvas.toDataURL('image/jpeg',0.92);
        pdf.addImage(img,'JPEG',0,0,pageWmm,pageHmm);
        var fname=(cust.name||'Bill').replace(/[^a-zA-Z0-9]/g,'')+'_'+t+'.pdf';
        pdf.save(fname);
      }catch(e){alert('PDF export failed: '+e.message);}
    },function(e){alert('PDF export failed: '+e.message);});
  }
  // Shared renderer: writes the bill HTML into an offscreen iframe (identical markup to
  // print/JPEG), rasterizes via html2canvas, hands the canvas to onDone. Used by both
  // saveJPEG and savePDF so the two outputs are pixel-identical.
  function renderBillCanvas(onDone,onErr){
    var bill=buildBillHTML();
    var iframe=document.createElement('iframe');
    iframe.style.cssText='position:fixed;left:-9999px;top:0;width:380px;height:1200px;border:0;background:#fff';
    document.body.appendChild(iframe);
    var doc=iframe.contentDocument||iframe.contentWindow.document;
    var fullHtml='<!DOCTYPE html><html><head><meta charset="UTF-8"/><style>'+bill.css+'</style></head><body>'+bill.body+'</body></html>';
    doc.open();doc.write(fullHtml);doc.close();
    setTimeout(function(){
      var body=doc.body;
      html2canvas(body,{backgroundColor:'#ffffff',scale:2,width:body.scrollWidth,height:body.scrollHeight,windowWidth:body.scrollWidth,windowHeight:body.scrollHeight}).then(function(canvas){
        if(iframe.parentNode) document.body.removeChild(iframe);
        try{onDone(canvas);}catch(e){if(onErr)onErr(e);}
      }).catch(function(e){
        if(iframe.parentNode) document.body.removeChild(iframe);
        if(onErr)onErr(e);
      });
    },200);
  }
  function thermalPrint(){
    if(t===0){alert('Cannot print a zero-amount bill.');return;}
    try{
      var bytes=ESCPOS.encodeBill(cust,{hotel:HOTEL_NAME,upi:upiId,previewBillNo:previewBillNo});
      ThermalPrinter.print(bytes).catch(function(e){
        alert('Thermal print failed: '+e.message+'\n\nTip: Configure transport in Users → Thermal Printer Settings, or use PDF/JPEG instead.');
      });
    }catch(e){
      alert('Encode error: '+e.message);
    }
  }
  return h('div',{className:'ovl',onClick:onClose},
    h('div',{className:'modal',onClick:function(e){e.stopPropagation();}},
      h('div',{className:'mhdr'},h('span',{style:{fontWeight:700,fontSize:13}},'Bill — '+cust.name),h('div',{className:'row',style:{gap:5,flexWrap:'wrap'}},
        h('button',{className:'btn btn-a xs',onClick:printBill},'🖨 Print'),
        h('button',{className:'btn xs',onClick:saveJPEG},'🖼 JPEG'),
        h('button',{className:'btn xs',style:{background:'#B91C1C',color:'#fff',borderColor:'#B91C1C'},onClick:savePDF},'📄 PDF'),
        h('button',{className:'btn xs',style:{background:'#0F766E',color:'#fff',borderColor:'#0F766E'},onClick:thermalPrint},'🧾 Thermal'),
        h('button',{className:'btn xs',style:{background:'#25D366',color:'#fff',borderColor:'#25D366'},onClick:sendWhatsApp},'📱 WhatsApp'),
        h('button',{className:'btn xs',style:{background:'#2563eb',color:'#fff',borderColor:'#2563eb'},onClick:sendSMS},'💬 SMS'),
        h('button',{className:'btn xs',onClick:onClose},'✕')
      )),
      h('div',{className:'mbody'},
        // Editable customer details at checkout
        h('div',{style:{background:'#FEF3E2',borderRadius:8,padding:8,marginBottom:10}},
          h('div',{style:{fontSize:11,fontWeight:700,color:'#B45309',marginBottom:5}},'Customer Details (editable)'),
          h('div',{style:{marginBottom:5}},
            h('div',{className:'muted',style:{fontSize:10,marginBottom:2}},'Name'),
            h('input',{value:editName,onChange:function(e){setEditName(e.target.value);setEdited(true);},placeholder:'Customer name'})
          ),
          h('div',{style:{marginBottom:edited?6:0}},
            h('div',{className:'muted',style:{fontSize:10,marginBottom:2}},'Phone (10 digits)'),
            h('input',{value:editPhone,onChange:function(e){setEditPhone(e.target.value);setEdited(true);},placeholder:'Optional',type:'tel'})
          ),
          edited&&h('button',{className:'btn btn-a xs',style:{width:'100%',justifyContent:'center'},onClick:saveEdits},'💾 Save Changes')
        ),
        h('div',{ref:billRef,className:'receipt',style:{background:'#fff',padding:'4px 0'}},
        h('div',{style:{textAlign:'center',marginBottom:12}},h('div',{style:{fontSize:18,fontWeight:700,letterSpacing:3}},'GAVTHAN'),h('div',{style:{fontSize:11,color:'var(--text-2)'}},'Receipt / Bill')),
        h('div',{style:{display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:2}},h('b',null,cust.name),h('span',null,dateOf(billDateTime(cust)||cust.date))),
        h('div',{style:{fontSize:12,marginBottom:2}},'Room/Table: ',h('b',null,cust.room)),
        cust.phone&&h('div',{style:{fontSize:12,marginBottom:4}},'Ph: ',h('b',null,cust.phone)),
        h('div',{className:'hr'}),
        h('table',{style:{width:'100%',fontSize:12,borderCollapse:'collapse'}},
          h('thead',null,h('tr',null,['Item','Qty','Rate','Amt'].map(function(hd,i){return h('th',{key:hd,style:{textAlign:i===0?'left':'right',padding:'3px 0',borderBottom:'1px solid var(--border)',fontWeight:700}},hd);}))),
          h('tbody',null,cust.items.map(function(it){return h('tr',{key:it.id},h('td',{style:{padding:'4px 0'}},it.name),h('td',{style:{textAlign:'right',padding:'4px 0'}},it.qty),h('td',{style:{textAlign:'right',padding:'4px 0'}},'₹'+it.price),h('td',{style:{textAlign:'right',padding:'4px 0',fontWeight:700}},'₹'+(it.price*it.qty)));}))
        ),
        h('div',{className:'hr'}),
        (function(){
          var dA=discountAmt(cust),aA=adjustAmt(cust);
          if(!(dA>0||cust.adjustment_on&&aA!==0)) return null;
          var rowsB=[h('div',{key:'s',style:{display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:2}},
            h('span',{style:{color:'var(--text-2)'}},'Subtotal'),h('span',null,'₹'+rawTotal(cust)))];
          if(dA>0) rowsB.push(h('div',{key:'d',style:{display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:2,color:'#166534'}},
            h('span',null,'Discount ('+cust.discount_pct+'%)'),h('span',null,'-₹'+dA)));
          if(cust.adjustment_on&&aA!==0) rowsB.push(h('div',{key:'a',style:{display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:2,color:aA<0?'#166534':'#991B1B'}},
            h('span',null,'Adjustment'),h('span',null,(aA>0?'+':'')+'₹'+aA)));
          if((cust.discount_on||cust.adjustment_on)&&cust.reason) rowsB.push(h('div',{key:'r',style:{fontSize:11,color:'var(--text-2)',fontStyle:'italic',marginBottom:2}},'Reason: '+cust.reason));
          return h('div',{style:{marginBottom:6}},rowsB);
        })(),
        h('div',{style:{display:'flex',justifyContent:'space-between',fontWeight:700,fontSize:16}},h('span',null,'Total'),h('span',{style:{color:'#B45309'}},'₹'+t)),
        h('div',{style:{textAlign:'center',fontSize:11,color:'var(--text-2)',marginTop:12}},'Thank you for visiting Gavthan!')
        )
      )
    )
  );
}

// ── RESET PASSWORD SCREEN ──────────────────────────
function ResetPasswordScreen(props){
  var _p1=useState('');var p1=_p1[0];var setP1=_p1[1];
  var _p2=useState('');var p2=_p2[0];var setP2=_p2[1];
  var _err=useState('');var err=_err[0];var setErr=_err[1];
  var _ok=useState(false);var ok=_ok[0];var setOk=_ok[1];
  var _busy=useState(false);var busy=_busy[0];var setBusy=_busy[1];
  function submit(){
    if(p1.length<6){setErr('Password must be at least 6 characters.');return;}
    if(p1!==p2){setErr('Passwords do not match.');return;}
    setBusy(true);setErr('');
    supa.auth.updateUser({password:p1}).then(function(r){
      setBusy(false);
      if(r.error){setErr(r.error.message);return;}
      setOk(true);
      supa.auth.signOut();
    }).catch(function(e){setBusy(false);setErr(e.message);});
  }
  return h('div',{className:'login-wrap'},
    h('div',{className:'login-box'},
      h('div',{className:'login-logo'},h('em',null,'Gavthan')),
      h('div',{className:'login-sub'},'Set New Password'),
      ok
        ? h('div',null,
            h('div',{className:'msg-ok',style:{lineHeight:1.7}},'✓ Password updated successfully! Please login with your new password.'),
            h('button',{className:'btn btn-a',style:{width:'100%',justifyContent:'center',marginTop:8},onClick:props.onDone},'Go to Login')
          )
        : h('div',null,
            err&&h('div',{className:'msg-err'},err),
            h('div',{className:'fld'},h('label',null,'New Password'),
              h('input',{type:'password',value:p1,onChange:function(e){setP1(e.target.value);},placeholder:'Min 6 characters'})),
            h('div',{className:'fld',style:{marginBottom:16}},h('label',null,'Confirm Password'),
              h('input',{type:'password',value:p2,onChange:function(e){setP2(e.target.value);},placeholder:'Re-enter password',
                onKeyDown:function(e){if(e.key==='Enter')submit();}})),
            h('button',{className:'btn btn-a',style:{width:'100%',justifyContent:'center'},onClick:submit,disabled:busy},
              busy&&h('span',{className:'spin'}),'Update Password')
          )
    )
  );
}

// ── ROOT ───────────────────────────────────────────
function Root(){
  var _user=useState(undefined);var user=_user[0];var setUser=_user[1];
  var _recovery=useState(false);var recovery=_recovery[0];var setRecovery=_recovery[1];
  useEffect(function(){
    if(!isConfigured)return;
    // Detect password recovery link (Supabase appends #type=recovery to URL)
    if((window.location.hash||'').indexOf('type=recovery')!==-1){
      setRecovery(true);
    }
    var unsub=supa.auth.onAuthStateChange(function(event,session){
      if(event==='PASSWORD_RECOVERY'){setRecovery(true);return;}
      if(session&&session.user){setUser(session.user);}
      else{setUser(null);}
    });
    supa.auth.getSession().then(function(r){
      setUser(r.data&&r.data.session?r.data.session.user:null);
    });
    return function(){unsub.data&&unsub.data.subscription&&unsub.data.subscription.unsubscribe();};
  },[]);
  if(!isConfigured)return h(SetupScreen,null);
  if(recovery)return h(ResetPasswordScreen,{onDone:function(){
    setRecovery(false);
    // Clean the recovery hash from URL
    if(window.history&&window.history.replaceState){
      window.history.replaceState(null,'',window.location.pathname+window.location.search);
    }
  }});
  if(user===undefined)return h('div',{style:{display:'flex',alignItems:'center',justifyContent:'center',minHeight:'100vh'}},h('span',{className:'spin'}));
  if(!user)return h(LoginScreen,null);
  return h(App,{user:user});
}

// Mounted from main.js entry (App root exported below)



export { Root };
