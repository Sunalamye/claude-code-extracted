#!/usr/bin/env node
// Universal extractor for `bun build --compile` single-file executables.
//
// Works on Linux (ELF), macOS (Mach-O) and Windows (PE) without any external
// tooling — no objcopy, no platform branching. The trick: the embedded payload
// always ends with a fixed 16-byte trailer magic, with a 32-byte Offsets struct
// immediately before it. Reading `byte_count` from Offsets gives us the start
// of the bundle, which is all we need.
//
// Reference: https://github.com/oven-sh/bun/blob/main/src/StandaloneModuleGraph.zig
//
// Layout (relative positions inside the host binary):
//
//   ... [bundle: byte_count bytes] [Offsets 32B] [trailer 16B] ...
//
// Offsets (little-endian, 32 bytes):
//   u64 byte_count
//   u32 modules_ptr.offset, u32 modules_ptr.length   (payload-relative)
//   u32 entry_point_id
//   u32 compile_exec_argv_ptr.offset, u32 .length
//   u32 flags
//
// CompiledModuleGraphFile (52 bytes per entry):
//   StringPointer {u32 offset, u32 length}  name
//   StringPointer                           contents
//   StringPointer                           sourcemap
//   StringPointer                           bytecode
//   StringPointer                           module_info
//   StringPointer                           bytecode_origin_path
//   u8 encoding   (0=binary, 1=latin1, 2=utf8)
//   u8 loader     (0=jsx, 1=js, 2=ts, ..., 10=napi, ...)
//   u8 module_format (0=none, 1=cjs, 2=esm)
//   u8 side       (0=server, 1=client)
//
// Usage:
//   node extract.cjs <binary> <output-dir>

'use strict';

const fs = require('fs');
const path = require('path');

const TRAILER = Buffer.from('\n---- Bun! ----\n', 'binary');
const TRAILER_SIZE = TRAILER.length; // 16
const OFFSETS_SIZE = 32;
const ENTRY_SIZE = 52;

const LOADER_NAMES = [
  'jsx', 'js', 'ts', 'tsx', 'css', 'file', 'json', 'jsonc', 'toml', 'wasm',
  'napi', 'base64', 'dataurl', 'text', 'bunsh', 'sqlite', 'sqlite_embedded',
  'html', 'yaml', 'json5', 'md',
];
const ENCODING_NAMES = ['binary', 'latin1', 'utf8'];
const FORMAT_NAMES = ['none', 'cjs', 'esm'];

const u32 = (b, o) => b.readUInt32LE(o);
const u64 = (b, o) => Number(b.readBigUInt64LE(o));
const readSP = (b, o) => ({ offset: u32(b, o), length: u32(b, o + 4) });

function detectContainer(buf) {
  if (buf.length >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return 'ELF';
  const m = buf.readUInt32LE(0);
  if (m === 0xfeedface || m === 0xfeedfacf || m === 0xcefaedfe || m === 0xcffaedfe) return 'Mach-O';
  if (buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x5a) return 'PE';
  return 'unknown';
}

function findTrailer(buf) {
  const idx = buf.lastIndexOf(TRAILER);
  if (idx < 0) {
    throw new Error(
      'trailer magic not found — input is not a bun --compile binary, ' +
      'or the payload has been stripped',
    );
  }
  return idx;
}

function parse(file) {
  const buf = fs.readFileSync(file);
  const container = detectContainer(buf);
  const trailerStart = findTrailer(buf);
  const offsetsStart = trailerStart - OFFSETS_SIZE;
  if (offsetsStart < 0) throw new Error('trailer too close to file start');

  const byteCount = u64(buf, offsetsStart + 0);
  const payloadStart = trailerStart - OFFSETS_SIZE - byteCount;
  if (payloadStart < 0) {
    throw new Error(`negative payload start (byte_count=${byteCount}, file=${buf.length})`);
  }

  const payload = buf.subarray(payloadStart, trailerStart + TRAILER_SIZE);

  const offAt = payload.length - TRAILER_SIZE - OFFSETS_SIZE;
  const modulesOffset = u32(payload, offAt + 8);
  const modulesLength = u32(payload, offAt + 12);
  const entryId = u32(payload, offAt + 16);
  const argv = readSP(payload, offAt + 20);
  const flags = u32(payload, offAt + 28);

  if (modulesLength % ENTRY_SIZE !== 0) {
    throw new Error(`module table size ${modulesLength} not divisible by ${ENTRY_SIZE}`);
  }
  const count = modulesLength / ENTRY_SIZE;

  const meta = {
    container,
    fileSize: buf.length,
    trailerAt: trailerStart,
    payloadStart,
    payloadLen: payload.length,
    byteCount,
    modulesOffset,
    modulesLength,
    entryId,
    argvOffset: argv.offset,
    argvLength: argv.length,
    flags,
    fileCount: count,
  };

  const files = [];
  for (let i = 0; i < count; i++) {
    const base = modulesOffset + i * ENTRY_SIZE;
    const name = readSP(payload, base + 0);
    const contents = readSP(payload, base + 8);
    const sourcemap = readSP(payload, base + 16);
    const bytecode = readSP(payload, base + 24);
    const moduleInfo = readSP(payload, base + 32);
    const bytecodeOriginPath = readSP(payload, base + 40);
    const encoding = payload.readUInt8(base + 48);
    const loader = payload.readUInt8(base + 49);
    const moduleFormat = payload.readUInt8(base + 50);
    const side = payload.readUInt8(base + 51);

    const sp = (s) => payload.subarray(s.offset, s.offset + s.length);
    files.push({
      index: i,
      isEntry: i === entryId,
      name: sp(name).toString('utf8'),
      contents: sp(contents),
      sourcemap: sourcemap.length ? sp(sourcemap) : null,
      bytecode: bytecode.length ? sp(bytecode) : null,
      moduleInfo: moduleInfo.length ? sp(moduleInfo) : null,
      bytecodeOriginPath: bytecodeOriginPath.length ? sp(bytecodeOriginPath).toString('utf8') : null,
      encoding,
      loader,
      moduleFormat,
      side,
    });
  }
  return { meta, files };
}

function sanitize(raw) {
  return (
    raw
      .replace(/^\/\$bunfs\/root\/?/, '')
      .replace(/^compiled:\/\/root\/?/, '')
      .replace(/^\/+/, '') || 'anonymous'
  );
}

function main() {
  const [, , inFile, outDir] = process.argv;
  if (!inFile || !outDir) {
    console.error('usage: extract.cjs <binary> <output-dir>');
    process.exit(2);
  }
  const { meta, files } = parse(inFile);
  console.error('[meta]', meta);

  fs.mkdirSync(outDir, { recursive: true });
  for (const f of files) {
    const rel = sanitize(f.name);
    const out = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, f.contents);
    if (f.sourcemap) fs.writeFileSync(out + '.map.bin', f.sourcemap);
    if (f.bytecode) fs.writeFileSync(out + '.bytecode.bin', f.bytecode);
    if (f.moduleInfo) fs.writeFileSync(out + '.moduleinfo.bin', f.moduleInfo);
    console.log(
      `${f.isEntry ? 'E' : ' '} ${String(f.contents.length).padStart(12)}  ` +
        `enc=${ENCODING_NAMES[f.encoding] || f.encoding} ` +
        `ld=${LOADER_NAMES[f.loader] || f.loader} ` +
        `fmt=${FORMAT_NAMES[f.moduleFormat] || f.moduleFormat} ` +
        `side=${f.side}` +
        `${f.bytecode ? ` +bc(${f.bytecode.length})` : ''}` +
        `${f.sourcemap ? ` +smap(${f.sourcemap.length})` : ''}  ` +
        `${rel}`,
    );
  }

  fs.writeFileSync(
    path.join(outDir, '_manifest.json'),
    JSON.stringify(
      {
        meta,
        files: files.map((f) => ({
          index: f.index,
          isEntry: f.isEntry,
          name: f.name,
          sanitized: sanitize(f.name),
          contentsLength: f.contents.length,
          sourcemapLength: f.sourcemap?.length ?? 0,
          bytecodeLength: f.bytecode?.length ?? 0,
          moduleInfoLength: f.moduleInfo?.length ?? 0,
          bytecodeOriginPath: f.bytecodeOriginPath,
          encoding: ENCODING_NAMES[f.encoding],
          loader: LOADER_NAMES[f.loader],
          moduleFormat: FORMAT_NAMES[f.moduleFormat],
          side: f.side === 0 ? 'server' : 'client',
        })),
      },
      null,
      2,
    ),
  );
}

if (require.main === module) main();

module.exports = { parse, detectContainer };
