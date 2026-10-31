"use strict";
// Minimal ZIP packer for the bridge's own files; no third-party runtime is bundled.
const fs=require("node:fs");
const path=require("node:path");
const zlib=require("node:zlib");
const crypto=require("node:crypto");
const root=path.resolve(__dirname,"../plugin");
const manifest=JSON.parse(fs.readFileSync(path.join(root,"manifest.json"),"utf8"));
const table=Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);return c>>>0;});
function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=table[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
const files=[];
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(entry.isFile())files.push(full);else throw new Error("Refusing a non-regular archive entry");}}
for(const name of ["main.js","manifest.json"])files.push(path.join(root,name));
for(const name of ["lib","renderer"])walk(path.join(root,name));
files.sort();const locals=[],centrals=[];let offset=0;
for(const file of files){
  const relative=path.relative(root,file).split(path.sep).join("/");
  if(!/\.(js|json|css|html)$/.test(relative))throw new Error("Unexpected file: "+relative);
  const name=Buffer.from(relative),bytes=fs.readFileSync(file),packed=zlib.deflateRawSync(bytes),crc=crc32(bytes);
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(8,8);local.writeUInt16LE(0x21,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(name.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(8,10);central.writeUInt16LE(0x21,14);central.writeUInt32LE(crc,16);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
  locals.push(local,name,packed);centrals.push(central,name);offset+=local.length+name.length+packed.length;
}
const directory=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
const output=process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,"../dist",manifest.id+"-"+manifest.version+".piplug");fs.mkdirSync(path.dirname(output),{recursive:true});const archive=Buffer.concat([...locals,directory,end]);fs.writeFileSync(output,archive);
console.log(JSON.stringify({output,files:files.length,bytes:archive.length,sha256:crypto.createHash("sha256").update(archive).digest("hex")},null,2));
