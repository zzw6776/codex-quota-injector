import assert from 'node:assert/strict';
import test from 'node:test';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {isRelayStateCurrent} from '../src/platform.mjs';
import {useTempDir} from './helpers.mjs';

test('[platform:windows-native][platform:wsl-native] 后台 WSL 身份探针隐藏窗口且仍核对 boot ID 与启动 ticks', async t => {
 const dir=await useTempDir(t,'wsl-readiness-console-');const path=join(dir,'state.json');
 await writeFile(path,JSON.stringify({version:2,pid:123,generation:'current',bootId:'boot',processStartTicks:456}));
 const calls=[];const execFileImpl=async(file,args,options)=>{calls.push({file,args,options});return {stdout:'boot 456\n'}};
 assert.equal(await isRelayStateCurrent(path,'current',{wslNative:true,execFileImpl}),true);
 assert.equal(calls.length,1);assert.equal(calls[0].file,'wsl.exe');assert.equal(calls[0].options.windowsHide,true);
 assert.match(calls[0].args.at(-1),/process_id=123/);
 assert.equal(await isRelayStateCurrent(path,'current',{wslNative:true,execFileImpl:async()=>({stdout:'different-boot 456\n'})}),false);
 assert.equal(await isRelayStateCurrent(path,'current',{wslNative:true,execFileImpl:async()=>({stdout:'boot 999\n'})}),false);
});

test('[platform:windows-native][platform:wsl-native] 旧版 WSL 身份的两次查询均隐藏窗口并保留时间校验', async t => {
 const dir=await useTempDir(t,'wsl-legacy-console-');const path=join(dir,'state.json');
 await writeFile(path,JSON.stringify({version:1,pid:123,generation:'legacy',processStartedAt:104560}));
 const calls=[];const execFileImpl=async(file,args,options)=>{calls.push({file,args,options});return {stdout:calls.length===1?'boot 456\n':'100 100\n'}};
 assert.equal(await isRelayStateCurrent(path,'legacy',{wslNative:true,execFileImpl}),true);
 assert.equal(calls.length,2);assert.ok(calls.every(x=>x.options.windowsHide===true));
});
